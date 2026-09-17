#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tests for write_boot_file() — the save path onto the boot medium.

Why this exists: the Settings screen failed with

    Could not save even after remounting /cdrom read-write:
    [Errno 13] Permission denied: '/cdrom/audit.conf'

for as long as the station has run on Ubuntu, and nobody could tell from the
message that it was a PERMISSION problem rather than a read-only-media problem.
There are two separate gates on writing to a FAT boot stick and the old code
lifted only one of them. These tests pin down both, plus the mount handling
around them, so the distinction cannot quietly regress.

Runs anywhere, including Windows: the filesystem, sudo and the mount table are
all stubbed. What it cannot prove is that `sudo -n sh -c 'cat > ...'` is
permitted on the live image — only the stick can answer that.

    python3 tools/test-boot-write.py
"""
import importlib.util
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))

# Import server.py without running main(). It reads the filesystem at import
# time (SEARCH_DIRS) but starts nothing.
_spec = importlib.util.spec_from_file_location("als_server",
                                               os.path.join(HERE, "gui", "server.py"))
srv = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(srv)

# os.geteuid() is POSIX-only and elevate() calls it. Stand in for an ordinary
# non-root desktop user so these tests run on Windows too — that is the account
# the kiosk backend actually runs as, so it is also the case worth testing.
WINDOWS_NO_GETEUID = not hasattr(os, "geteuid")
if WINDOWS_NO_GETEUID:
    os.geteuid = lambda: 1000
    srv.shutil.which = lambda n: "/usr/bin/sudo" if n == "sudo" else shutil.which(n)

PASS = [0]
FAIL = []


def check(name, cond, detail=""):
    if cond:
        PASS[0] += 1
        print("  ok   %s" % name)
    else:
        FAIL.append(name)
        print("  FAIL %s   %s" % (name, detail))


class Media:
    """A pretend boot medium: records what the code did to the mount, and can
    refuse writes the way a root-owned FAT filesystem refuses them."""

    def __init__(self, tmp, plain_errno=None, ro=True, sudo_ok=True):
        self.dir = tmp
        self.conf = os.path.join(tmp, "audit.conf")
        self.plain_errno = plain_errno   # None = plain writes work
        self.ro = ro
        self.sudo_ok = sudo_ok
        self.mount_calls = []            # ["rw", "ro", ...]
        self.root_writes = []            # text handed to the root helper
        self.real_open = srv.open if hasattr(srv, "open") else open

    # --- the stubs -------------------------------------------------------
    def fake_atomic_write(self, path, text):
        if self.plain_errno is not None and not self.elevated_ok_now():
            raise OSError(self.plain_errno, os.strerror(self.plain_errno), path)
        with open(path, "w") as fh:
            fh.write(text)

    def elevated_ok_now(self):
        return False    # plain writes never get privileges; only the helper does

    def fake_remount(self, mp, mode):
        self.mount_calls.append(mode)
        if mode == "rw":
            self.ro = False
        elif mode == "ro":
            self.ro = True
        return True

    def fake_is_readonly(self, mp):
        return self.ro

    def fake_run(self, cmd, **kw):
        """Stands in for subprocess.run() of the sudo helper."""
        class R:
            pass
        r = R()
        self.root_writes.append(kw.get("input"))
        if not self.sudo_ok:
            r.returncode = 1
            r.stderr = "sudo: a password is required"
            return r
        # The helper runs as root, so it succeeds where the plain write did not.
        dest = cmd[-1]
        with open(dest, "w") as fh:
            fh.write(kw.get("input") or "")
        r.returncode = 0
        r.stderr = ""
        return r


def run_case(name, plain_errno, ro=True, sudo_ok=True, mp="/cdrom", body="KEY=\"v\"\n"):
    tmp = tempfile.mkdtemp()
    m = Media(tmp, plain_errno=plain_errno, ro=ro, sudo_ok=sudo_ok)
    saved = (srv.atomic_write, srv.remount, srv.is_readonly,
             srv.mount_point, srv.subprocess.run, srv.CONF_PATH)
    try:
        srv.atomic_write = m.fake_atomic_write
        srv.remount = m.fake_remount
        srv.is_readonly = m.fake_is_readonly
        srv.mount_point = lambda p: mp
        srv.subprocess.run = m.fake_run
        srv.CONF_PATH = m.conf
        err = srv.write_boot_file(m.conf, body)
        on_disk = None
        if os.path.exists(m.conf):
            with open(m.conf) as fh:
                on_disk = fh.read()
        return m, err, on_disk
    finally:
        (srv.atomic_write, srv.remount, srv.is_readonly,
         srv.mount_point, srv.subprocess.run, srv.CONF_PATH) = saved
        shutil.rmtree(tmp, ignore_errors=True)


print("write_boot_file")

# 1. Nothing wrong: a writable medium takes the plain write, and the mount is
#    never touched at all.
m, err, disk = run_case("plain", plain_errno=None, ro=False)
check("writable media: saves", err is None, err)
check("writable media: content written", disk == 'KEY="v"\n', repr(disk))
check("writable media: mount untouched", m.mount_calls == [], m.mount_calls)
check("writable media: no root helper", m.root_writes == [], m.root_writes)

# 2. THE BUG. Read-only mount, and the medium refuses the write to a non-root
#    process even once it is read-write (errno 13). The old code stopped here
#    and told the operator it had "remounted read-write" — which it had.
m, err, disk = run_case("eacces", plain_errno=13, ro=True)
check("EACCES: saves anyway", err is None, err)
check("EACCES: content written", disk == 'KEY="v"\n', repr(disk))
check("EACCES: went through the root helper", len(m.root_writes) == 1, m.root_writes)
check("EACCES: helper got the right bytes", m.root_writes[:1] == ['KEY="v"\n'], m.root_writes)
check("EACCES: remounted rw then back to ro", m.mount_calls == ["rw", "ro"], m.mount_calls)

# 3. A genuinely read-only filesystem (errno 30) takes the same route: the
#    remount lifts it, and if the write still fails the helper covers it.
m, err, disk = run_case("erofs", plain_errno=30, ro=True)
check("EROFS: saves", err is None, err)
check("EROFS: stick left read-only", m.mount_calls == ["rw", "ro"], m.mount_calls)

# 4. Already-writable media that still refuses the write must NOT be forced
#    read-only afterwards. The old finally: did that unconditionally, so one
#    failed save left the operator's writable drive read-only for the session.
m, err, disk = run_case("no-force-ro", plain_errno=13, ro=False)
check("already rw: saves", err is None, err)
check("already rw: mount never touched", m.mount_calls == [], m.mount_calls)
check("already rw: still used the root helper", len(m.root_writes) == 1, m.root_writes)

# 5. mount_point() returns "/" when nothing above the path is a mountpoint (a
#    dev checkout). Remounting THAT read-only would take down the running
#    desktop. It must never happen.
m, err, disk = run_case("root-fs", plain_errno=13, ro=True, mp="/")
check("mp=/: never remounts the root filesystem", m.mount_calls == [], m.mount_calls)
check("mp=/: still tries the root helper", len(m.root_writes) == 1, m.root_writes)

# 6. sudo refused: the operator must see sudo's own words, not a filesystem
#    story, and the stick must still go back to read-only.
m, err, disk = run_case("no-sudo", plain_errno=13, ro=True, sudo_ok=False)
check("sudo refused: reports an error", err is not None)
check("sudo refused: quotes sudo", err and "password is required" in err, err)
check("sudo refused: names the permission errno", err and "Errno 13" in err, err)
check("sudo refused: stick back to read-only", m.mount_calls == ["rw", "ro"], m.mount_calls)

# 7. The helper hands a path to root, so it must not accept any path.
print("write_as_root path guard")
saved_conf = srv.CONF_PATH
try:
    tmp = tempfile.mkdtemp()
    srv.CONF_PATH = os.path.join(tmp, "audit.conf")
    why = srv.write_as_root("/etc/shadow", "x")
    check("refuses a path off the boot media", why == "refusing to write outside the boot media", why)
    why = srv.write_as_root(os.path.join(tmp, "sub", "audit.conf"), "x")
    check("refuses a subdirectory of the boot media", why is not None, why)
    shutil.rmtree(tmp, ignore_errors=True)
finally:
    srv.CONF_PATH = saved_conf

# 8. atomic_write must not leave a truncated file behind when the write fails.
print("atomic_write")
tmp = tempfile.mkdtemp()
try:
    target = os.path.join(tmp, "audit.conf")
    with open(target, "w") as fh:
        fh.write("AUDIT_URL=\"https://example\"\nPASSWORD=\"secret\"\n")

    class Boom(str):
        """A str whose write() explodes halfway, like a stick pulled mid-save."""

    orig_open = __builtins__["open"] if isinstance(__builtins__, dict) else __builtins__.open

    def exploding_open(path, mode="r", *a, **kw):
        fh = orig_open(path, mode, *a, **kw)
        if "w" in mode and path.endswith(".new"):
            real_write = fh.write

            def bad(_text):
                real_write("AUDIT_U")
                raise OSError(28, "No space left on device", path)
            fh.write = bad
        return fh

    srv_open = srv.open if hasattr(srv, "open") else None
    srv.open = exploding_open
    try:
        srv.atomic_write(target, "NEW=\"1\"\n")
        check("atomic_write: raised on failure", False, "no exception")
    except OSError:
        check("atomic_write: raised on failure", True)
    finally:
        if srv_open is None:
            del srv.open
        else:
            srv.open = srv_open

    with open(target) as fh:
        after = fh.read()
    check("atomic_write: original survives a failed write",
          after == 'AUDIT_URL="https://example"\nPASSWORD="secret"\n', repr(after))

    srv.atomic_write(target, 'NEW="1"\n')
    with open(target) as fh:
        after = fh.read()
    check("atomic_write: replaces on success", after == 'NEW="1"\n', repr(after))
    check("atomic_write: leaves no .new behind",
          not os.path.exists(target + ".new"))
finally:
    shutil.rmtree(tmp, ignore_errors=True)

# 9. elevate() — the one place that decides how this backend becomes root.
print("elevate")
saved_geteuid = getattr(os, "geteuid", None)
saved_which = srv.shutil.which
try:
    os.geteuid = lambda: 1000
    srv.shutil.which = lambda n: "/usr/bin/sudo"
    check("non-root: prefixes sudo -n",
          srv.elevate(["mount"]) == ["sudo", "-n", "mount"], srv.elevate(["mount"]))
    os.geteuid = lambda: 0
    check("root: runs the command directly",
          srv.elevate(["mount"]) == ["mount"], srv.elevate(["mount"]))
    os.geteuid = lambda: 1000
    srv.shutil.which = lambda n: None
    check("no sudo on PATH: runs the command directly",
          srv.elevate(["mount"]) == ["mount"], srv.elevate(["mount"]))
finally:
    srv.shutil.which = saved_which
    if saved_geteuid is not None:
        os.geteuid = saved_geteuid

print("")
print("%d passed, %d failed" % (PASS[0], len(FAIL)))
for f in FAIL:
    print("  - %s" % f)
sys.exit(1 if FAIL else 0)
