# Remote access

OASIS is remote-first: the runtime lives on the computer or server that holds your project, and any modern browser — laptop, tablet or phone — is the interface. Files, shell commands, model requests and keys stay on that machine.

By default `oasis web` listens on `127.0.0.1` only, prints a private link, and creates a fresh access key on every start.

## Security model

| Layer | What OASIS does |
| --- | --- |
| Access key | Every API call needs `Authorization: Bearer <key>`. The key is 256 bits of randomness, compared in constant time. Browsers never send it automatically, so cross-site requests cannot use it. |
| Wrong keys | 10 wrong keys from one address within a minute lock that address out for 5 minutes (`429` with `Retry-After`). |
| Host names | Only `localhost`, literal IP addresses and the host names you configure are accepted, which blocks DNS-rebinding attacks. Browser requests must also be same-origin. |
| Transport | Binding to a network address requires HTTPS unless you pass `--allow-insecure-lan`. |
| Model keys | Provider keys, updates and hardware detection are accepted only from the same computer or over HTTPS. Keys are stored on the server and never sent back to the browser. |
| Proxies | `X-Forwarded-*` headers are ignored unless you pass `--trust-proxy`, and even then only from a proxy on the same computer. Forwarded requests never count as local. |
| Page | Strict Content-Security-Policy (hashed inline scripts, `connect-src 'self'`), `X-Frame-Options: DENY`, `nosniff`, `no-referrer`. |
| Approvals | Shell commands, package installs, deletions and bundle installs wait for your approval in the browser. |

## On the same computer

```sh
oasis web --open
```

The terminal prints `http://127.0.0.1:3917/app/#token=…`. The key is moved out of the address bar into the tab's session storage as soon as the page opens.

## Behind an HTTPS reverse proxy or tunnel (recommended)

Keep OASIS on loopback and let a proxy terminate TLS:

```sh
oasis web --public-url https://oasis.example.com --trust-proxy
```

- `--public-url` accepts that host name and keeps the same access key across restarts (saved owner-only as `web-access-key` in the OASIS config folder).
- `--trust-proxy` lets OASIS see the original HTTPS origin and client address from a proxy on the same machine.
- `oasis web key` prints the saved key; `oasis web key --rotate` replaces it (restart `oasis web` afterwards — old links stop working).
- `OASIS_WEB_TOKEN` (32+ characters of letters, digits, `-` or `_`) overrides the saved key, which suits containers and secret managers.

Caddy:

```caddyfile
oasis.example.com {
  reverse_proxy 127.0.0.1:3917
}
```

nginx:

```nginx
location / {
  proxy_pass http://127.0.0.1:3917;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_buffering off;
}
```

Tunnels work the same way. With [Tailscale Serve](https://tailscale.com/kb/1312/serve), `tailscale serve --bg 3917` publishes `https://<machine>.<tailnet>.ts.net` to your tailnet only; start OASIS with `--public-url https://<machine>.<tailnet>.ts.net --trust-proxy`. With [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/), point the tunnel at `http://127.0.0.1:3917` and add Cloudflare Access in front for a second factor.

Use `--allow-host NAME` (repeatable, `*.example.com` allowed) for extra names.

## Direct HTTPS on a private network

```sh
oasis web --host 0.0.0.0 --tls-cert cert.pem --tls-key key.pem
```

The private key file must be readable only by its owner (`chmod 600 key.pem`), and the certificate must include the address other devices use. [Tailscale](https://tailscale.com/kb/1153/enabling-https) can issue one for your machine.

`--allow-insecure-lan` serves plain HTTP on a network address. Traffic, including the access key, can then be read by anyone on the network, and provider keys cannot be entered from other devices. Use it only on a network you fully trust, never on the public Internet.

## Opening OASIS on another device

Open the remote link printed by `oasis web`, or open the address and paste the link or key into the message box. The key is remembered for that browser tab only.
