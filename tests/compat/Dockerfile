# An older GNOME Shell to run the tests against: ./scripts/dev.sh test-compat
# Fedora release -> GNOME Shell: 39 -> 45, 40 -> 46, 41 -> 47, 42 -> 48, 43 -> 49, 44 -> 50
ARG FEDORA=41
FROM registry.fedoraproject.org/fedora:${FEDORA}
RUN dnf install -y --setopt=install_weak_deps=False \
        gnome-shell gjs glib2 glib2-devel dbus-daemon dbus-tools mesa-dri-drivers \
        nodejs procps-ng pciutils findutils which util-linux \
    && dnf clean all \
    && useradd -m tester \
    # Xwayland, which the shell starts even when headless, needs its socket directory.
    && mkdir -m 1777 /tmp/.X11-unix \
    # A system bus (started by entry.sh) needs a machine id.
    && dbus-uuidgen --ensure=/etc/machine-id \
    # There is no logind here: without this directory the shell uses its
    # dummy login manager instead of failing on the missing service.
    && rm -rf /run/systemd/seats
COPY entry.sh /entry.sh
ENTRYPOINT ["/entry.sh"]
