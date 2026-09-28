# A backup of a Linux installation, for the test of the package for Windows

What `squorli backup` wrote on 28 September 2026 in an installation made by `deploy/install.sh` (Docker, the published
image 0.5.3, PostgreSQL 16.15 on Alpine with the collation `en_US.utf8`), inside a `docker:27-dind` container that no
longer exists. `deploy/windows/test/acceptance.ps1` restores it on Windows and signs in with the key next to it.

- `squorli-database.sql`, `squorli-files.tar.gz`: the backup, byte for byte (`.gitattributes` keeps Git from touching the
  line ends: a dump with CRLF would put a carriage return into the last column of every row).
- `owner.key.json`: the key of the installation's owner, made for this test.
- `marker.txt`: the text of the message the owner wrote; its attachment is the text `data.mjs` writes.
- The backup's `env` is left out: a restore never reads it.

Everything in here is test data of a throwaway installation: the server's key, the account and the setup code protect
nothing. A newer server reads the dump through its migrations; make a new one only when that stops being true.
