# Bambu Cloud (optional)

Cloud sign-in is off by default. In **Setup**, open the optional **MakerWorld & Bambu Cloud** section. The cloud status link also opens the section, and `/login` redirects to it.

Enter your Bambu account email, then enter the latest six-digit code Bambu sends you. Use **Resend code** if it hasn't arrived or **Change email** if the address is wrong. If Bambu requests another step, enter the code from your authenticator app.

If email sign-in is blocked, open **Troubleshooting → Import a MakerWorld token** for browser-specific instructions. BambuBoard verifies the new token before saving it. A rejected token or temporary service failure keeps your existing sign-in intact.

Successful sign-in enables cloud features and stores the token locally in `data/accessToken.json` (gitignored). **Check connection** verifies a saved sign-in. Setup shows when a token has expired. **Sign out** clears it and disables cloud features.

MakerWorld profile/model images, filament weight and some printer/history fields require cloud data. Telemetry widgets, the camera and FTPS toolpaths use your LAN credentials. Leave cloud sign-in disabled for LAN operation.

[Back to the README](../README.md#optional-extras)
