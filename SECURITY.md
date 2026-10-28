# Security policy

Herald is a local-first AI control plane. A configured Router can execute
coding tools, start CLI agents, access model credentials, and operate inside
the selected workspace. Treat Router access as equivalent to access to the
user account running Herald.

## Supported versions

Security fixes go into the latest published release. Please upgrade to it and
check the problem still happens before reporting.

| Version | Supported |
| --- | --- |
| Latest 0.4.x | Yes |
| 0.3.x and older | No |

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's
private vulnerability-reporting form for this repository. If that form is not
available, open a draft security advisory from the repository's **Security**
tab and include:

- the affected version or commit;
- reproduction steps and the security impact;
- whether credentials or real user data were exposed; and
- any proposed mitigation, if known.

Do not include live tokens, private prompts, session captures, or customer
data. Revoke exposed credentials before sending a report. You should receive
an acknowledgement within seven days.

## Deployment baseline

- Keep the Router bound to loopback unless remote access is required.
- Set a strong `HERALD_API_KEY` before binding beyond loopback, and put TLS or
  a trusted private-network proxy in front of remote access.
- Run Herald as an unprivileged user and scope `HERALD_WORKSPACE` narrowly.
- Review agent tool approvals; do not give untrusted users access to shell,
  filesystem, connector, capture, admin, or publication endpoints.
- Keep secrets in environment variables, the OS keyring, or Herald's encrypted
  vault. Never commit `.env`, browser captures, Router databases, or logs.
- Use `HERALD_MAX_VOICE_UPLOAD_BYTES` to lower the default 25 MiB audio limit
  when appropriate.

See [the deployment guide](docs/DEPLOYMENT_GUIDE.md) before exposing Herald to
another device.
