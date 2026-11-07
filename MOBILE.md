# Mobile and tablet setup

OASIS does not ship a standalone browser/PWA product or a native Android/iOS package. The supported mobile workflow is to connect to a normal OASIS session running on a computer that contains the project.

## Use a computer's project from your phone

Start the connected workspace on the computer that contains your project:

```sh
cd /path/to/your/project
oasis web --host 0.0.0.0
```

OASIS prints local network addresses and a QR code. Open the address on your phone while both devices are on the same trusted private network. Keep the computer and OASIS running while you use the workspace.

The agent runs on the computer and works with that computer's project. Do not port-forward the workspace or expose it to the public internet. Use a trusted network and the application's access controls.

## Advanced Android use

Power users can run the CLI directly in an Android terminal environment such as Termux after installing Node.js 22.15 or newer and Git. Clone the OASIS repository, install its dependencies, and install the CLI from that checkout using the [CLI instructions](README.md#download-and-install). This is a manual setup, not a one-click Android installer.

## Which option should I use?

| Goal | Use |
|---|---|
| Control a project on a nearby computer | `oasis web --host 0.0.0.0` |
| Run the CLI on Android itself | Termux (advanced/manual) |
