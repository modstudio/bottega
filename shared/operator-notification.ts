/** Chooses and invokes the best available desktop notification. */

export type OperatorNotification = { title: string; body: string; link: string }
export type NotificationCommand = { argv: string[] } | null

const appleScriptString = (value: string) =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')

export function notificationCommand(
  platform: NodeJS.Platform,
  available: ReadonlySet<string>,
  title: string,
  body: string,
  link: string,
): NotificationCommand {
  if (platform === 'darwin' && available.has('terminal-notifier')) {
    return { argv: ['terminal-notifier', '-title', title, '-message', body, '-open', link] }
  }
  if (platform === 'darwin' && available.has('osascript')) {
    const message = `${body} ${link}`
    return {
      argv: [
        'osascript',
        '-e',
        `display notification "${appleScriptString(message)}" with title "${appleScriptString(title)}"`,
      ],
    }
  }
  if (platform === 'linux' && available.has('notify-send')) {
    return { argv: ['notify-send', title, body] }
  }
  return null
}

type Spawned = { exited: Promise<number>; unref(): void }
export type NotificationRuntime = {
  platform: NodeJS.Platform
  which(name: string): string | null
  spawn(argv: string[]): Spawned
  error(message: string): void
}

const runtime: NotificationRuntime = {
  platform: process.platform,
  which: (name) => Bun.which(name),
  spawn: (argv) => Bun.spawn(argv, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }),
  error: (message) => console.error(message),
}

/** Detached by construction: notification delivery never delays its caller. */
export function sendOperatorNotification(
  input: OperatorNotification,
  r: NotificationRuntime = runtime,
): void {
  try {
    const names = ['terminal-notifier', 'osascript', 'notify-send']
    const available = new Set(names.filter((name) => r.which(name)))
    const command = notificationCommand(r.platform, available, input.title, input.body, input.link)
    if (!command) {
      r.error(`orch: no desktop notifier is available for ${r.platform}`)
      return
    }
    const child = r.spawn(command.argv)
    child.unref()
    void child.exited.then((code) => {
      if (code !== 0) r.error(`orch: desktop notifier exited ${code}`)
    })
  } catch (error) {
    r.error(`orch: desktop notification failed: ${String(error)}`)
  }
}
