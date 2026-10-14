# BambuBoard 3.3.1 release QA

This patch packages the Express compatibility and large-toolpath preview fixes already merged into main at `2ca2da2912f0ba9fedf9a815af51cd03c67b3966`. The release preparation changes the app and lockfile version to 3.3.1, updates the changelog and links this record. Node remains on major version 24. The maintainer approved GitHub publication on October 13, 2026. NAS installation remains separate from publication.

## Code review

The review covers the changes since v3.3.0: Express routing and configured-directory file serving, cancellation and retry handling, bounded downloads and incremental parsing, loading/recovery controls, renderer ownership and finished-view invalidation, the Docker runtime and release checks. No blocking defect was found in those changes. Existing server, browser and native-container checks cover the affected behavior.

## Validation evidence

- Main's publication run [38486455090](https://github.com/t0nyz0/BambuBoard/actions/runs/38486455090) passed source checks and both native container architectures before publishing the image.
- The tested application passes 58 server tests and 11 G-code browser groups, including a 31 MiB fixture with 1.25 million lines, size/line limit handling, job cancellation, suspended animation frames, renderer recovery and finished-view resize invalidation.
- The published build rendered the actual 31,422,894-byte toolpath in Chromium, Firefox and WebKit. It produced 52 parsed layers and 1,852,802 vertices without JavaScript errors. Download, processing and rendering states were observed.
- Before the previous main-container update, the published image passed an isolated test on the NAS with copied settings and the saved scene. Native NAS capture rendered the complete scene with one toolpath widget, 18 scene layers and 16 iframes; initial loading and capture took about 77 seconds.
- After that update, the saved settings, two scenes and cloud account were preserved; telemetry, camera decoding and the toolpath were verified. On October 13, a fresh HTTP check confirmed that all three served preview files still match the tested source, the printer is connected and the saved cloud account is signed in.

Local release preparation passed 71 JavaScript syntax checks, 58 server tests with no skips, all 11 G-code browser groups, all 20 widgets and 15 responsive layouts, streaming browser checks, zero npm audit findings and reproducible vendor bundles. Both linux/amd64 and linux/arm64 packages built with Node 24.21.0 and app version 3.3.1. The native ARM container passed all 58 server tests and the WebGL preview check. Both packages passed startup and management-page checks; local AMD startup used emulation. The earlier main pipeline covers both architectures on native runners.

These preparation checks preceded the release tag. The release workflow repeats source and native-container validation before publishing; the final release notes identify its passing run and published image digest. At NAS verification, the installed app exposed version 3.3.0 with the reviewed fixes. The versioned image must be checked against the published digest before any separately approved installation.

## Packaging and rollout

Follow the existing v3.3.0 pattern: update package.json and package-lock.json together, merge approved release preparation, tag v3.3.1, wait for the validation and Docker publication workflow, then create the GitHub release with notes. Docker publication produces linux/amd64 and linux/arm64 images with 3.3.1, 3.3, 3 and latest tags. GitHub supplies source ZIP and tar.gz downloads; prior releases have no custom uploaded binary assets.

Before replacing the NAS main container, back up its complete data mount and retain its previous image and container settings. Test the exact published image with copied settings, then verify the app version, image digest, printer connection, camera, saved scene and cloud status after installation.

## Limits

Large toolpaths still require memory and initial processing time; visible progress does not promise instant rendering. The 64 MiB and 2,000,000-line limits remain intentional. A real YouTube broadcast, a new-account email/MFA sign-in, additional printer firmware and a sustained NAS streaming soak are outside this patch's verified scope.
