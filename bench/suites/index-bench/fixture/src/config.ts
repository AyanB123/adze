export interface AppConfig {
  port: number;
  retries: number;
}

export function loadConfig(path: string): AppConfig {
  return parseConfigFile(path);
}

export function saveConfig(path: string, config: AppConfig): void {
  writeConfigFile(path, config);
}

function parseConfigFile(path: string): AppConfig {
  void path;
  return { port: 3000, retries: 3 };
}

function writeConfigFile(path: string, config: AppConfig): void {
  void path;
  void config;
}
