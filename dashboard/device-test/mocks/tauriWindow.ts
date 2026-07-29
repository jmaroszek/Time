type Unlisten = () => void;

const appWindow = {
  close: async () => undefined,
  isMaximized: async () => false,
  minimize: async () => undefined,
  onFocusChanged: async (): Promise<Unlisten> => () => undefined,
  onResized: async (): Promise<Unlisten> => () => undefined,
  show: async () => undefined,
  startDragging: async () => undefined,
  toggleMaximize: async () => undefined,
};

export function getCurrentWindow() {
  return appWindow;
}
