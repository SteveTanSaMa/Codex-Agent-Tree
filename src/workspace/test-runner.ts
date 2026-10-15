// Dedicated parent-death supervisor. Not a security boundary against malicious
// tests that deliberately detach themselves. Only operator-approved commands enter.
import { spawn } from "node:child_process";
const command = JSON.parse(process.argv[2]!) as {
  executable: string;
  args: string[];
};
const child = spawn(command.executable, command.args, {
  shell: false,
  detached: process.platform !== "win32",
  stdio: ["ignore", "inherit", "inherit"],
  env: process.env,
});
let done = false;
function kill() {
  if (child.pid)
    try {
      process.kill(
        process.platform === "win32" ? child.pid : -child.pid,
        "SIGKILL",
      );
    } catch {}
}
const timer = setTimeout(() => {
  kill();
  process.exitCode = 124;
}, 30000);
process.stdin.resume();
process.stdin.on("end", () => {
  if (!done) kill();
});
process.on("SIGTERM", kill);
process.on("SIGINT", kill);
child.once("error", () => {
  clearTimeout(timer);
  process.stdin.destroy();
  process.exitCode = 125;
});
child.once("exit", (code, signal) => {
  done = true;
  clearTimeout(timer);
  kill(); // Also stop any ordinary background descendants in this process group.
  process.stdin.destroy();
  process.exitCode = process.exitCode || code || (signal ? 137 : 0);
});
