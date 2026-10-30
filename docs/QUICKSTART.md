# OASIS in five minutes

OASIS is an open-source coding helper. You choose the AI model it talks to; OASIS does not include a model or a paid subscription.

## Desktop app (no terminal needed for the basic path)

1. Open the [latest OASIS release](https://github.com/FAHTHIZ/oasis/releases/latest) and download the file for your computer.
2. Open the installer. If your operating system warns that the app is unsigned, check that you downloaded it from the official OASIS release page before you continue.
3. Start OASIS and choose the folder for the project you want it to work on. OASIS can read and change files inside that workspace, so choose a project folder—not your whole home folder.
4. In the **Model provider** setup, choose one of the three paths:
   - **I have an API key:** choose the provider, open its official key page, paste the key into the masked field, and press **Test & save provider**. A key is never shown back after it is saved.
   - **Use a free gateway:** the CLI guided setup can install OmniRoute, start its local gateway after approval, and verify the model connection. The desktop app does not yet perform that whole installation flow by itself. Free gateways can be slow or limited.
   - **Use a model on my computer:** install and start [Ollama](https://ollama.com/download). OASIS can list models already installed on the same computer. Small local models may be less capable than larger hosted models.
5. Wait for the provider test to say it worked. The test checks the model's ability to respond with a tool call; it does not run that tool.
6. Try **Explain this project**, then ask OASIS to make one small improvement. Review proposed commands and file changes before approving them.

## First useful task

Open a project that you understand, then try:

> Read the project first. Explain how its main parts fit together. Do not change files yet.

After you have reviewed the explanation, give it a small, specific task:

> Find one clear bug, explain the proposed fix, change only the necessary files, and run the relevant tests. If you cannot verify the fix, say so.

## If something goes wrong

- **No model is connected:** open Model provider and test the connection again.
- **Ollama is not found:** install it from the official link, open it, install a model, and press the Ollama choice again.
- **A provider test fails:** check the provider name, exact model ID, endpoint URL, account access and key. OASIS does not save a new provider configuration when the test fails.
- **A command asks for approval:** read the action and its target. Say no when you do not understand what it will do.
- **The app cannot open a folder:** check that the folder still exists and that your computer account can access it.
- **Need more detail:** run `oasis doctor` in the terminal version and read [the install guide](INSTALL.md).

## Important limits

OASIS is beta software. It runs commands with the permissions of your computer account; approval prompts are not a substitute for an operating-system sandbox. The desktop installers are currently unsigned. Back up important work and use a separate, trusted project folder when trying unfamiliar code.
