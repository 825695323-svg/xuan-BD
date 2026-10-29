import { createContext, useContext } from 'react';

/** 应用画布填满当前窗口；左右栏保持固定像素，窗口尺寸变化只影响中间内容区域。 */
export const DESIGN_WIDTH = 1280;
export const DESIGN_HEIGHT = 800;

export const CanvasContext = createContext<HTMLElement | null>(null);
export const useCanvasContainer = (): HTMLElement | null => useContext(CanvasContext);
