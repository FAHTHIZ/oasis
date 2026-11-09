# Remote access

The OASIS web workspace runs on the computer or server that holds your project. Any modern browser can open it. By default it listens on `127.0.0.1` only.

## On the same computer

```sh
oasis web --open
```

The terminal prints a private link (`http://127.0.0.1:3917/app/#token=…`). Anyone with the link can use the workspace, so keep it private.

## From another device

Serve over HTTPS with a certificate the other device trusts:

```sh
oasis web --host 0.0.0.0 --tls-cert cert.pem --tls-key key.pem
```

The private key file must be readable only by its owner (`chmod 600 key.pem`). For a private network you can also use [Tailscale](https://tailscale.com/kb/1153/enabling-https) to issue a certificate.

`--allow-insecure-lan` serves plain HTTP on a network address. Traffic, including the access token, can then be read by anyone on the network. Use it only on a network you fully trust, and never on the public Internet.
