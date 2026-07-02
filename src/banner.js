import pc from 'picocolors';

const ART = String.raw`
 _____          _ _       _         ____  _
|_   _|_      _(_) |_ ___| |__     |  _ \| |
  | | \ \ /\ / / | __/ __| '_ \    | | | | |
  | |  \ V  V /| | || (__| | | |   | |_| | |___
  |_|   \_/\_/ |_|\__\___|_| |_|   |____/|_____|
`;

/** Print the startup banner. */
export function printBanner(version) {
  console.log(pc.magenta(ART));
  console.log(
    `  ${pc.bold('Twitch Downloader')} ${pc.dim(`v${version}`)}  ${pc.dim('·')}  ${pc.dim('VODs, clips & live streams via yt-dlp')}`,
  );
  console.log('');
}
