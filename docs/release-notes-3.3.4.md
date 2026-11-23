# 3.3.4

- **Setup** waits for printer data, offers a retry after a settings error, and opens the built-in layout as soon as the printer is ready. MakerWorld sign-in is optional, and Setup reports expired credentials that need attention.
- **Layout** separates content size from visual scale, adds zoom to a selected widget and searchable widget categories, and makes the working draft and live output easier to compare. Supported image and text layers render consistently in Layout and Live.
- **Live** puts the OBS URL, canvas dimensions, and scene download beside the preview. YouTube setup starts with the stream key. The standalone toolpath preview has print angle and zoom controls.
- **Docker and source installs** get a security refresh. Docker builds use updated Alpine packages, including GLib. Source installs use the maintained system FFmpeg.

## Updating

The Docker image is available for `linux/amd64` and `linux/arm64`. Synology Container Manager, QNAP, Portainer, and TrueNAS use the same image through their existing Docker or Compose projects.

```sh
docker pull ghcr.io/t0nyz0/bambuboard:3.3.4
```

Keep and back up your existing data mount. Older root-owned data may need the one-time permissions migration. [Docker upgrade instructions](../README.md#upgrading-an-existing-docker-installation)

If you run from source, install FFmpeg on the host and put it on `PATH` or set `FFMPEG_BIN` in the service environment. [Source installation steps](../README.md#from-source)
