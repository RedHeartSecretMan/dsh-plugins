# Third-party notices

## Managed FFmpeg fallback

When no local FFmpeg build can compose a storyboard, the plugin can download
the following platform packages from the npm registry:

- `@ffmpeg-installer/*` 4.1.x, LGPL-2.1, https://www.npmjs.com/package/@ffmpeg-installer/ffmpeg
- `@ffprobe-installer/*` 5.x, LGPL-2.1, https://www.npmjs.com/package/@ffprobe-installer/ffprobe

The binaries are distributed under the GNU Lesser General Public License,
version 2.1. Source code and license terms are available from the FFmpeg
project (https://ffmpeg.org/) and the package repositories linked above.
The plugin itself remains MIT-licensed.

Downloads are pinned by URL and SHA-512 integrity in `lib/managed-ffmpeg.js`;
the binaries are stored outside the plugin package under
`$DSH_HOME/tools/ffmpeg/managed/`.
