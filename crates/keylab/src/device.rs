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
use zeroize::{Zeroize, Zeroizing};

nix::ioctl_write_int!(eviocsclockid, b'E', 0xa0);

const INPUT_EVENT_SIZE: usize = std::mem::size_of::<libc::input_event>();
const TIME_COMPONENT_SIZE: usize = std::mem::size_of::<libc::time_t>();
const TYPE_OFFSET: usize = std::mem::size_of::<libc::timeval>();

pub struct DeviceEvent {
    t_ms: u64,
    event_type: u16,
    code: u16,
    value: i32,
}

impl DeviceEvent {
    pub fn is_key(&self) -> bool {
        self.event_type == evdev::EventType::KEY.0
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

pub fn for_each_matching<F>(name_substring: &str, mut callback: F) -> Result<DeviceScan>
where
    F: FnMut(PathBuf, InputDevice) -> Result<()>,
{
    let entries = match fs::read_dir("/dev/input") {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(DeviceScan {
                matched_count: 0,
                present_names: Vec::new(),
            });
        }
        Err(error) => return Err(error).context("failed to enumerate input devices"),
    };
    let mut matched_count = 0;
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
        if !name.contains(name_substring) {
            continue;
        }
        let uniq = device.unique_name().map(str::to_owned);
        set_monotonic_clock(&device)?;
        callback(path, InputDevice { device, name, uniq })?;
        matched_count += 1;
    }
    present_names.sort();
    present_names.dedup();
    Ok(DeviceScan {
        matched_count,
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
    let clock_id = libc::CLOCK_MONOTONIC as nix::sys::ioctl::ioctl_param_type;
    // SAFETY: EVIOCSCLOCKID receives a valid evdev file descriptor and an integer clock id.
    unsafe { eviocsclockid(device.as_raw_fd(), clock_id) }
        .context("failed to set monotonic input clock")?;
    Ok(())
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
}
