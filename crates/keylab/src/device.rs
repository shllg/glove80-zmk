use anyhow::{Context, Result};
use evdev::raw_stream::RawDevice;
use nix::errno::Errno;
use std::ffi::OsStr;
use std::fs::{self, OpenOptions};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use tracing::warn;
use zeroize::{Zeroize, Zeroizing};

// EVIOCSCLOCKID takes a pointer to the clock id, not the id by value: the kernel
// reads it with copy_from_user, so passing it by value fails with EFAULT.
nix::ioctl_write_ptr!(eviocsclockid, b'E', 0xa0, libc::c_int);

const INPUT_EVENT_SIZE: usize = std::mem::size_of::<libc::input_event>();
const TIME_COMPONENT_SIZE: usize = std::mem::size_of::<libc::time_t>();
const TYPE_OFFSET: usize = std::mem::size_of::<libc::timeval>();

pub struct DeviceEvent {
    t_ms: u64,
    event_type: u16,
    code: u16,
    value: i32,
}

/// `EV_KEY` also carries pointer buttons. evsieve merges the Kensington trackball into the same
/// virtual device as the Glove80, so its clicks arrive here as `EV_KEY` codes that no keyboard
/// keymap contains — they would otherwise inflate both the keystroke count and the unattributed
/// Tier B share. Ranges are `BTN_MISC..=BTN_GEAR_UP` and `BTN_TRIGGER_HAPPY..`.
const POINTER_BUTTON_RANGES: [std::ops::RangeInclusive<u16>; 2] = [0x100..=0x151, 0x2c0..=0x2ff];

pub fn is_pointer_button(code: u16) -> bool {
    POINTER_BUTTON_RANGES
        .iter()
        .any(|range| range.contains(&code))
}

impl DeviceEvent {
    pub fn is_key(&self) -> bool {
        self.event_type == evdev::EventType::KEY.0
    }

    /// A pointer button is an `EV_KEY` event that is not a keystroke.
    pub fn is_pointer_button(&self) -> bool {
        self.is_key() && is_pointer_button(self.code)
    }

    pub fn is_sequence_loss(&self) -> bool {
        self.event_type == evdev::EventType::SYNCHRONIZATION.0 && self.code == 3
    }

    pub fn t_ms(&self) -> u64 {
        self.t_ms
    }

    pub fn code(&self) -> u16 {
        self.code
    }

    pub fn value(&self) -> i32 {
        self.value
    }
}

impl Drop for DeviceEvent {
    fn drop(&mut self) {
        self.t_ms.zeroize();
        self.event_type.zeroize();
        self.code.zeroize();
        self.value.zeroize();
    }
}

pub struct InputDevice {
    device: RawDevice,
    pub name: String,
    pub uniq: Option<String>,
}

pub struct DeviceScan {
    pub matched_count: usize,
    /// Devices that matched a rule but could not be prepared for capture on this scan. Counted
    /// separately so "nothing matched your configuration" is never printed for devices that did.
    pub skipped_count: usize,
    pub present_names: Vec<String>,
}

impl InputDevice {
    pub fn next_event(&mut self) -> io::Result<Option<DeviceEvent>> {
        // Read exactly one event so no ordered event batch ever exists in userspace. The raw bytes
        // and parsed event are both zeroized with non-elidable writes when their scopes end.
        let mut buffer = Zeroizing::new([0_u8; INPUT_EVENT_SIZE]);
        let bytes_read = match nix::unistd::read(self.device.as_raw_fd(), &mut buffer[..]) {
            Ok(bytes_read) => bytes_read,
            Err(Errno::EAGAIN) => return Ok(None),
            Err(error) => return Err(io::Error::from_raw_os_error(error as i32)),
        };
        if bytes_read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "input device disconnected",
            ));
        }
        if bytes_read != INPUT_EVENT_SIZE {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "input device returned a partial event",
            ));
        }
        parse_event(&buffer)
    }
}

/// Resolves which rule a device name belongs to. `None` means the device is not ours to read.
/// Ambiguity is impossible by construction — `Config::validate` rejects overlapping fragments —
/// so the first match is the only match.
pub fn matching_rule(name: &str, fragments: &[String]) -> Option<usize> {
    fragments
        .iter()
        .position(|fragment| name.contains(fragment.as_str()))
}

pub fn for_each_matching<F>(fragments: &[String], callback: F) -> Result<DeviceScan>
where
    F: FnMut(PathBuf, InputDevice, usize) -> Result<()>,
{
    scan_with(fragments, set_monotonic_clock, callback)
}

/// The scan, with the preparation step as a parameter. It is a seam and not a convenience: a
/// device that refuses `EVIOCSCLOCKID` cannot be conjured on demand, but a preparation that fails
/// can, and the skip path below is the behaviour that used to take the whole daemon down.
fn scan_with<P, F>(fragments: &[String], mut prepare: P, mut callback: F) -> Result<DeviceScan>
where
    P: FnMut(&RawDevice) -> Result<()>,
    F: FnMut(PathBuf, InputDevice, usize) -> Result<()>,
{
    let entries = match fs::read_dir("/dev/input") {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(DeviceScan {
                matched_count: 0,
                skipped_count: 0,
                present_names: Vec::new(),
            });
        }
        Err(error) => return Err(error).context("failed to enumerate input devices"),
    };
    let mut matched_count = 0;
    let mut skipped_count = 0;
    let mut present_names = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !is_event_path(&path) {
            continue;
        }
        let Ok(device) = open_raw_device(&path) else {
            continue;
        };
        let Some(name) = device.name() else {
            continue;
        };
        let name = name.to_owned();
        present_names.push(name.clone());
        let Some(rule_index) = matching_rule(&name, fragments) else {
            continue;
        };
        let uniq = device.unique_name().map(str::to_owned);
        // Every other per-device failure in this loop is a skip; this one used to be fatal. A
        // matched device that disappears between `open` and the ioctl — exactly what an input
        // remapper with `persist=reopen` produces when the keyboard reconnects — therefore took
        // the daemon down with it, including every other keyboard that was working, and systemd
        // restarted it into the same race five seconds later. Skipping leaves the device to the
        // next scan, which is when it will have settled.
        //
        // The device is never captured with realtime timestamps instead: those jump whenever NTP
        // steps the clock, which would silently corrupt every hold and gap measurement in Tier A.
        // A device that cannot be switched is not measurable, so it is left alone and reported.
        if let Err(error) = prepare(&device) {
            warn!(
                device_name = %name,
                event_path = %path.display(),
                error = %format!("{error:#}"),
                "failed to set the monotonic input clock; skipping this device for this scan"
            );
            skipped_count += 1;
            continue;
        }
        callback(path, InputDevice { device, name, uniq }, rule_index)?;
        matched_count += 1;
    }
    present_names.sort();
    present_names.dedup();
    Ok(DeviceScan {
        matched_count,
        skipped_count,
        present_names,
    })
}

fn is_event_path(path: &Path) -> bool {
    path.file_name()
        .map(OsStr::as_bytes)
        .is_some_and(|name| name.starts_with(b"event"))
}

fn open_raw_device(path: &Path) -> io::Result<RawDevice> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(path)?;
    RawDevice::try_from(file)
}

fn parse_event(buffer: &[u8; INPUT_EVENT_SIZE]) -> io::Result<Option<DeviceEvent>> {
    let seconds = read_time_component(&buffer[..TIME_COMPONENT_SIZE])?;
    let micros = read_time_component(&buffer[TIME_COMPONENT_SIZE..TYPE_OFFSET])?;
    if seconds < 0 || !(0..1_000_000).contains(&micros) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "input event has an invalid monotonic timestamp",
        ));
    }
    let t_ms =
        u64::try_from(seconds)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid event timestamp"))?
            .saturating_mul(1_000)
            .saturating_add(u64::try_from(micros / 1_000).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidData, "invalid event timestamp")
            })?);
    let event_type = read_u16(&buffer[TYPE_OFFSET..TYPE_OFFSET + 2]);
    let code = read_u16(&buffer[TYPE_OFFSET + 2..TYPE_OFFSET + 4]);
    let value = read_i32(&buffer[TYPE_OFFSET + 4..TYPE_OFFSET + 8]);
    Ok(Some(DeviceEvent {
        t_ms,
        event_type,
        code,
        value,
    }))
}

fn read_time_component(bytes: &[u8]) -> io::Result<i64> {
    match bytes.len() {
        8 => {
            let mut value = [0_u8; 8];
            value.copy_from_slice(bytes);
            Ok(i64::from_ne_bytes(value))
        }
        4 => {
            let mut value = [0_u8; 4];
            value.copy_from_slice(bytes);
            Ok(i64::from(i32::from_ne_bytes(value)))
        }
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "unsupported input event timestamp layout",
        )),
    }
}

fn read_u16(bytes: &[u8]) -> u16 {
    let mut value = [0_u8; 2];
    value.copy_from_slice(bytes);
    u16::from_ne_bytes(value)
}

fn read_i32(bytes: &[u8]) -> i32 {
    let mut value = [0_u8; 4];
    value.copy_from_slice(bytes);
    i32::from_ne_bytes(value)
}

fn set_monotonic_clock(device: &RawDevice) -> Result<()> {
    let clock_id: libc::c_int = libc::CLOCK_MONOTONIC;
    // SAFETY: EVIOCSCLOCKID receives a valid evdev file descriptor and a pointer to an
    // integer clock id that outlives the call.
    let errno = match unsafe { eviocsclockid(device.as_raw_fd(), &clock_id) } {
        Ok(_) => return Ok(()),
        Err(errno) => errno,
    };
    // The errno is the whole diagnosis: ENODEV is a device that went away mid-scan and will be
    // back, anything else is a device this kernel will not hand over monotonic timestamps for.
    Err(anyhow::Error::new(errno)).context(format!(
        "failed to set monotonic input clock (EVIOCSCLOCKID: {errno})"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_pointer_width = "64")]
    fn parses_one_native_input_event_without_a_sequence_buffer() {
        assert_eq!(INPUT_EVENT_SIZE, 24);
        let mut bytes = [0_u8; INPUT_EVENT_SIZE];
        bytes[0..8].copy_from_slice(&123_i64.to_ne_bytes());
        bytes[8..16].copy_from_slice(&456_000_i64.to_ne_bytes());
        bytes[16..18].copy_from_slice(&evdev::EventType::KEY.0.to_ne_bytes());
        bytes[18..20].copy_from_slice(&30_u16.to_ne_bytes());
        bytes[20..24].copy_from_slice(&1_i32.to_ne_bytes());
        let event = parse_event(&bytes)
            .unwrap_or_else(|error| panic!("{error}"))
            .unwrap_or_else(|| unreachable!());
        assert_eq!(event.t_ms(), 123_456);
        assert!(event.is_key());
        assert_eq!(event.code(), 30);
        assert_eq!(event.value(), 1);

        bytes[16..18].copy_from_slice(&evdev::EventType::SYNCHRONIZATION.0.to_ne_bytes());
        bytes[18..20].copy_from_slice(&3_u16.to_ne_bytes());
        let sequence_loss = parse_event(&bytes)
            .unwrap_or_else(|error| panic!("{error}"))
            .unwrap_or_else(|| unreachable!());
        assert!(sequence_loss.is_sequence_loss());
    }

    #[test]
    fn pointer_buttons_are_separated_from_keystrokes() {
        // Trackball and mouse buttons.
        for code in [0x110_u16, 0x111, 0x112, 0x113, 0x114, 0x151, 0x2c0, 0x2ff] {
            assert!(is_pointer_button(code), "{code:#x} is a pointer button");
        }
        // KEY_A, KEY_BACKSPACE, KEY_F23, and the high KEY_* block above the button ranges.
        for code in [30_u16, 14, 193, 255, 0x160, 0x1ff] {
            assert!(!is_pointer_button(code), "{code:#x} is a key");
        }
    }

    /// Feature-gated because creating a virtual device needs write access to `/dev/uinput` and
    /// read access to the `/dev/input/event*` node udev then creates — permissions no test suite
    /// can assume. A test that silently skipped itself would be worse than one that is absent:
    /// `--features uinput-tests` makes its absence a decision rather than an accident.
    #[cfg(feature = "uinput-tests")]
    mod uinput {
        use super::*;
        use evdev::uinput::VirtualDevice;
        use evdev::{AttributeSet, KeyCode};
        use std::time::{Duration, Instant};

        // `/dev/input` is global and cargo runs these two tests in parallel threads of one
        // process, so each test needs names no other test creates. A shared name makes one test's
        // device show up in the other's scan and both fail on the count.
        const CAPTURED: &str = "keylab uinput fixture captured";
        const REFUSES: &str = "keylab uinput fixture refuses";
        const KEPT: &str = "keylab uinput fixture kept";

        /// The device lives exactly as long as this value: dropping it closes the uinput file
        /// descriptor and the kernel destroys the node, on a panic and unwind as much as on a
        /// clean return. A failing test never leaves a fake keyboard on the machine.
        fn virtual_keyboard(name: &str) -> VirtualDevice {
            let mut keys = AttributeSet::<KeyCode>::new();
            keys.insert(KeyCode::KEY_A);
            let mut device = VirtualDevice::builder()
                .unwrap_or_else(|error| panic!("/dev/uinput is not writable: {error}"))
                .name(name)
                .with_keys(&keys)
                .unwrap_or_else(|error| panic!("{error}"))
                .build()
                .unwrap_or_else(|error| panic!("{error}"));
            wait_until_readable(&mut device, name);
            device
        }

        /// udev creates the node and applies its permissions after the ioctl returns, so the scan
        /// has to wait for the device to become readable rather than for it to exist.
        fn wait_until_readable(device: &mut VirtualDevice, name: &str) {
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline {
                let nodes = device
                    .enumerate_dev_nodes_blocking()
                    .unwrap_or_else(|error| panic!("{error}"));
                let ready = nodes.flatten().any(|path| {
                    open_raw_device(&path).is_ok_and(|opened| opened.name() == Some(name))
                });
                if ready {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            panic!(
                "the virtual device {name} never became readable; is this user in the input group?"
            );
        }

        #[test]
        fn a_virtual_device_matching_a_rule_is_captured() {
            let _device = virtual_keyboard(CAPTURED);
            let mut captured = Vec::new();
            let scan = for_each_matching(&[CAPTURED.to_owned()], |_path, device, rule_index| {
                captured.push((device.name.clone(), rule_index));
                Ok(())
            })
            .unwrap_or_else(|error| panic!("{error:#}"));

            assert_eq!(scan.matched_count, 1);
            assert_eq!(scan.skipped_count, 0);
            assert_eq!(captured, vec![(CAPTURED.to_owned(), 0)]);
            assert!(scan.present_names.iter().any(|name| name == CAPTURED));
        }

        #[test]
        fn a_matched_device_that_cannot_be_prepared_is_skipped_not_fatal() {
            let _refuses = virtual_keyboard(REFUSES);
            let _kept = virtual_keyboard(KEPT);
            let mut captured = Vec::new();
            let scan = scan_with(
                &[REFUSES.to_owned(), KEPT.to_owned()],
                |device| {
                    if device.name() == Some(REFUSES) {
                        anyhow::bail!("fixture refuses the monotonic clock");
                    }
                    set_monotonic_clock(device)
                },
                |_path, device, _rule_index| {
                    captured.push(device.name.clone());
                    Ok(())
                },
            )
            .unwrap_or_else(|error| {
                panic!("a device that cannot be prepared must not be fatal: {error:#}")
            });

            assert_eq!(scan.skipped_count, 1);
            assert_eq!(scan.matched_count, 1);
            assert_eq!(
                captured,
                vec![KEPT.to_owned()],
                "the other matched keyboard is still captured, which is the whole point"
            );
        }
    }

    #[test]
    fn resolves_each_device_name_to_exactly_one_rule() {
        let fragments = vec![
            "Evsieve Virtual Device".to_owned(),
            "AT Translated Set 2 keyboard".to_owned(),
        ];
        assert_eq!(matching_rule("Evsieve Virtual Device", &fragments), Some(0));
        assert_eq!(
            matching_rule("AT Translated Set 2 keyboard", &fragments),
            Some(1)
        );
        assert_eq!(matching_rule("MoErgo Glove80 Mouse", &fragments), None);
        assert_eq!(matching_rule("", &fragments), None);
    }
}
