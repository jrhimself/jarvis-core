# systemd units

Templates, not files to copy. Every path and account that belongs to a
particular machine is a placeholder, because the alternative is a repository
that records one person's home directory in eleven places.

| placeholder | what to put there |
| --- | --- |
| `__JARVIS_USER__` | the account the service runs as |
| `__JARVIS_HOME__` | that account's home directory |
| `__JARVIS_ROOT__` | the checkout the service runs from, e.g. `$HOME/jarvis` |
| `__JARVIS_WORKTREES__` | where a small fix's throwaway worktrees are made; never the live checkout |
| `__JARVIS_HOSTNAME__` | the name the TLS certificate is issued for |
| `__JARVIS_TIMEZONE__` | the zone the timers are scheduled in; defaults to the machine's own |

`scripts/install-units.sh` fills them in and installs the result. It takes the
values from the environment, defaulting to the account running it:

```
sudo JARVIS_ROOT=$HOME/jarvis JARVIS_HOSTNAME=<the certificate's name> \
  scripts/install-units.sh
```

Secrets are not here and must not be: the units read
`/etc/jarvis/jarvis.env`, root-readable, which systemd loads on their behalf.

## What each one is

| unit | what it does |
| --- | --- |
| `jarvis-brain.service` | the assistant itself; the only long-running one |
| `jarvis-backup.service` + `.timer` | nightly copy of the memory database |
| `jarvis-consolidate.service` + `.timer` | weekly pass that tidies what is remembered |
| `jarvis-corpus.service` + `.timer` | nightly pass over the owner's own notes |
| `jarvis-cert-renew@.service` + `.timer` | weekly certificate renewal, restarts the brain |
| `jarvis-self-deploy.path` + `.service` | watches for the handshake a self-written fix leaves behind |

The brain binds 443 as a non-root user through `CAP_NET_BIND_SERVICE`, and
nothing more. Everything else runs `ProtectSystem=strict` with an explicit
`ReadWritePaths`; the backup pass additionally runs with `PrivateNetwork=yes`,
because a job that only copies a file has no business reaching a network.
