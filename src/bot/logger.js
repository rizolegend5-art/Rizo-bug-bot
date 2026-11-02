import chalk from "chalk";

function getTimeStamp() {
  return new Date().toLocaleTimeString("id-ID", {
    hour12: false,
  });
}

function badge(label, color) {
  return color.bold(`[${label}]`);
}

function print(label, color, message) {
  console.log(`\n${chalk.gray(getTimeStamp())} ${badge(label, color)} ${message}`);
}

export const log = {
  info: (message) => print("INFO", chalk.cyan, message),
  success: (message) => print("SUCCESS", chalk.green, message),
  warning: (message) => print("WARNING", chalk.yellow, message),
  error: (message) => print("ERROR", chalk.red, message),
  loading: (message) => print("PROCESS", chalk.blue, message),
  whatsapp: (message) => print("WHATSAPP", chalk.greenBright, message),
};