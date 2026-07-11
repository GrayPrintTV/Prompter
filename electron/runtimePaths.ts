import path from 'node:path';

export const LOCAL_WHISPER_SIDECAR_RELATIVE_PATH = path.join('python', 'local_whisper_sidecar.py');
export const BUNDLED_WHISPER_SIDECAR_RELATIVE_PATH = path.join('whisper-sidecar', 'whisper-sidecar.exe');
export const BUNDLED_WHISPER_MODEL_NAME = 'base.en';
export const BUNDLED_WHISPER_MODEL_RELATIVE_PATH = path.join('models', BUNDLED_WHISPER_MODEL_NAME);
export const LOCAL_WHISPER_PYTHON_ENV_VAR = 'LOCAL_WHISPER_PYTHON_EXECUTABLE';
export const REQUIRED_WHISPER_MODEL_FILES = [
  'config.json',
  'model.bin',
  'tokenizer.json',
  'vocabulary.txt'
];

export type RuntimePathContext = {
  isPackaged: boolean;
  appPath: string;
  mainDirname: string;
  resourcesPath: string;
  env?: NodeJS.ProcessEnv;
};

export function isDevRuntime(context: RuntimePathContext) {
  return !context.isPackaged && Boolean(context.env?.VITE_DEV_SERVER_URL);
}

export function devEnvFileRoots(context: RuntimePathContext) {
  return context.isPackaged ? [] : [context.appPath];
}

export function resolveRendererIndexPath(context: RuntimePathContext) {
  return path.join(context.mainDirname, '..', 'dist', 'index.html');
}

export function resolveLocalWhisperSidecarPath(context: RuntimePathContext) {
  const root = context.isPackaged ? context.resourcesPath : context.appPath;
  return path.join(root, LOCAL_WHISPER_SIDECAR_RELATIVE_PATH);
}

export function resolveBundledWhisperSidecarPath(context: RuntimePathContext) {
  return path.join(context.resourcesPath, BUNDLED_WHISPER_SIDECAR_RELATIVE_PATH);
}

export function resolveBundledWhisperModelPath(context: RuntimePathContext) {
  return path.join(context.resourcesPath, BUNDLED_WHISPER_MODEL_RELATIVE_PATH);
}

export function resolveLocalWhisperWorkingDirectory(userDataPath: string) {
  return path.join(userDataPath, 'local-whisper-sidecar');
}

export type LocalWhisperLaunchPlan = {
  executablePath: string;
  args: string[];
  scriptPath: string | null;
  modelName: string;
  modelPath: string | null;
  localFilesOnly: boolean;
  bundled: boolean;
  workingDirectory: string;
};

export function resolveLocalWhisperLaunchPlan(
  context: RuntimePathContext,
  settingsPythonExecutablePath: string,
  settingsModelName: string,
  userDataPath: string,
  env: NodeJS.ProcessEnv = process.env
): LocalWhisperLaunchPlan {
  const workingDirectory = resolveLocalWhisperWorkingDirectory(userDataPath);
  if (context.isPackaged) {
    return {
      executablePath: resolveBundledWhisperSidecarPath(context),
      args: [],
      scriptPath: null,
      modelName: BUNDLED_WHISPER_MODEL_NAME,
      modelPath: resolveBundledWhisperModelPath(context),
      localFilesOnly: true,
      bundled: true,
      workingDirectory
    };
  }

  const scriptPath = resolveLocalWhisperSidecarPath(context);
  return {
    executablePath: resolvePythonExecutablePath(settingsPythonExecutablePath, env),
    args: [scriptPath],
    scriptPath,
    modelName: settingsModelName.trim(),
    modelPath: null,
    localFilesOnly: false,
    bundled: false,
    workingDirectory
  };
}

export function resolvePythonExecutablePath(
  settingsPythonExecutablePath: string,
  env: NodeJS.ProcessEnv = process.env
) {
  const override = env[LOCAL_WHISPER_PYTHON_ENV_VAR]?.trim();
  return override || settingsPythonExecutablePath.trim();
}

export function isPathLikeExecutable(executablePath: string) {
  return (
    path.isAbsolute(executablePath) ||
    executablePath.includes('/') ||
    executablePath.includes('\\')
  );
}

export function missingSidecarMessage(sidecarScriptPath: string) {
  return `Local Whisper sidecar script was not found at "${sidecarScriptPath}". Reinstall Prompter or run npm run build before starting Local Whisper.`;
}

export function missingBundledSidecarMessage(sidecarExecutablePath: string) {
  return `Bundled Local Whisper sidecar executable was not found at "${sidecarExecutablePath}". Rebuild the self-contained package.`;
}

export function missingBundledModelMessage(modelPath: string, missingFiles: string[]) {
  const suffix = missingFiles.length ? ` Missing: ${missingFiles.join(', ')}.` : '';
  return `Bundled Local Whisper model was not found or is incomplete at "${modelPath}".${suffix} Rebuild the self-contained package.`;
}

export function missingPythonExecutableMessage(pythonExecutablePath: string) {
  return `Could not start Local Whisper Python executable "${pythonExecutablePath}". Install Python, add it to PATH, set ${LOCAL_WHISPER_PYTHON_ENV_VAR}, or set Python in Developer mode.`;
}

export function localWhisperSpawnErrorMessage(
  error: NodeJS.ErrnoException | Error,
  executablePath: string,
  bundled = false
) {
  if ('code' in error && error.code === 'ENOENT') {
    return bundled ? missingBundledSidecarMessage(executablePath) : missingPythonExecutableMessage(executablePath);
  }
  return error.message;
}
