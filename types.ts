
export interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

export interface PoseResults {
  poseLandmarks: Landmark[];
  poseWorldLandmarks: Landmark[];
  image: any; // MediaPipe image source
}

export interface PhysioEyeRef {
  getScreenshot: () => string | null;
}

export interface AnalysisResult {
  feedback: string;
  isGoodForm: boolean;
  correction?: string;
}

export type TrackingMode = 'OPTIMAL' | 'DEGRADED' | 'ESTIMATED' | 'LOST';

export interface VisualContext {
  valgus: boolean;
  baselineKneeY: number; // Normalized 0-1
  isDeep: boolean;
  lean: boolean;
  hipShift: boolean;
  asymmetry: boolean;
}

export interface HUDState {
  message: string;
  color: string; // e.g., "#EF4444" (red-500) or "#10B981" (emerald-500)
  visible: boolean;
  trackingMode?: TrackingMode;
  visualContext?: VisualContext;
}

export type SessionStatus = 'IDLE' | 'COUNTDOWN' | 'ACTIVE' | 'SUMMARY';

// Window augmentation for MediaPipe globals loaded via CDN
declare global {
  interface Window {
    Pose: any;
    Camera: any;
    drawConnectors: any;
    drawLandmarks: any;
    POSE_CONNECTIONS: any;
  }
}
