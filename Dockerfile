FROM zmkfirmware/zmk-build-arm:stable

# Ensure west folder
RUN cd /tmp && rm -rf zmk-workspace && mkdir -p zmk-workspace

