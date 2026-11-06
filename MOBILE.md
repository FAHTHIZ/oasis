# Mobile and tablet setup

OASIS does not currently publish a native Android APK or an App Store package. There are three ways to use it from a phone or tablet.

## 1. Install the browser app

Open the [OASIS browser app](https://fahthiz.github.io/oasis/app/) in a supported mobile browser. Use the browser's **Install app** or **Add to Home Screen** command to pin it.

This is a browser-based app. It can work with browser storage or a connected GitHub project, but it does not have direct access to the phone's shell or arbitrary files on the device.

## 2. Use a computer's project from your phone

Start the connected workspace on the computer that contains your project:

```sh
cd /path/to/your/project
oasis web --host 0.0.0.0
```

OASIS prints local network addresses and a QR code. Open the address on your phone while both devices are on the same trusted private network. Keep the computer and OASIS running while you use the workspace.

The agent runs on the computer and works with that computer's project. Do not port-forward the workspace or expose it to the public internet. Use a trusted network and the application's access controls.

## 3. Serve the universal browser app from a computer

```sh
oasis app --lan
```

Open the LAN address on the phone and install the browser app from the browser menu. This is the standalone browser app, not the connected local shell workspace. It uses browser storage or a connected GitHub project.

## Advanced Android use

Power users can run the CLI directly in an Android terminal environment such as Termux after installing Node.js 22 or newer and Git. Clone the OASIS repository, install its dependencies, and install the CLI from that checkout using the [CLI instructions](README.md#cli). This is a manual setup, not a supported one-click Android installer.

## Which option should I use?

| Goal | Use |
|---|---|
| Pin OASIS to a phone home screen | Browser app |
| Control a project on a nearby computer | `oasis web --host 0.0.0.0` |
| Use the standalone app served by a computer | `oasis app --lan` |
| Run the CLI on Android itself | Termux (advanced/manual) |
