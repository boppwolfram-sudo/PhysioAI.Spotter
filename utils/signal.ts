
import { Landmark } from '../types';

/**
 * A buffer that stores the last N numeric values and calculates their average.
 * Used to smooth out jittery MediaPipe data (Low-pass filter).
 */
export class MovingAverage {
  private buffer: number[] = [];
  private readonly size: number;

  constructor(size: number = 5) {
    this.size = size;
  }

  /**
   * Adds a new value to the buffer and returns the current average.
   */
  update(value: number): number {
    this.buffer.push(value);
    
    // Maintain fixed window size
    if (this.buffer.length > this.size) {
      this.buffer.shift();
    }
    
    return this.average();
  }

  /**
   * Returns the current average of the buffer.
   */
  average(): number {
    if (this.buffer.length === 0) return 0;
    const sum = this.buffer.reduce((acc, val) => acc + val, 0);
    return sum / this.buffer.length;
  }

  /**
   * Resets the buffer.
   */
  reset() {
    this.buffer = [];
  }
}

/**
 * Exponential Moving Average (EMA) for stable baseline tracking.
 */
export class ExponentialMovingAverage {
  private value: number | null = null;
  private readonly alpha: number;

  constructor(window: number = 30) {
    this.alpha = 2 / (window + 1);
  }

  update(newValue: number): number {
    if (this.value === null) {
      this.value = newValue;
    } else {
      this.value = this.alpha * newValue + (1 - this.alpha) * this.value;
    }
    return this.value;
  }
  
  reset() {
    this.value = null;
  }

  getValue(): number {
    return this.value || 0;
  }
}

/**
 * Checks if all specified landmarks meet the minimum visibility threshold.
 */
export const areLandmarksVisible = (
  landmarks: Landmark[], 
  indices: number[], 
  threshold: number = 0.5
): boolean => {
  return indices.every(index => {
    const landmark = landmarks[index];
    return landmark && (landmark.visibility ?? 0) > threshold;
  });
};

/**
 * Linear interpolation between two landmarks.
 */
const lerpLandmark = (prev: Landmark, curr: Landmark, t: number): Landmark => {
  return {
    x: prev.x + (curr.x - prev.x) * t,
    y: prev.y + (curr.y - prev.y) * t,
    z: (prev.z || 0) + ((curr.z || 0) - (prev.z || 0)) * t,
    visibility: (prev.visibility || 0) + ((curr.visibility || 0) - (prev.visibility || 0)) * t
  };
};

/**
 * Stabilizer that implements robust filtering with interpolation.
 * - Visibility > 0.7: Trust current fully
 * - Visibility < 0.5: Use last known (if available)
 * - Visibility 0.5-0.7: Interpolate
 */
export class LandmarkStabilizer {
  private lastValidLandmarks: Landmark[] | null = null;
  private missingFrames: number = 0;
  private readonly maxMissingFrames: number = 10;
  private readonly LOW_CONFIDENCE = 0.5;
  private readonly HIGH_CONFIDENCE = 0.7;

  reset() {
    this.lastValidLandmarks = null;
    this.missingFrames = 0;
  }

  /**
   * Processes current landmarks and applies stabilization.
   * @param currentLandmarks The raw landmarks from MediaPipe
   * @param isValid External check if the pose is generally valid
   */
  process(currentLandmarks: Landmark[], isValid: boolean): { 
    landmarks: Landmark[] | null; 
    isEstimated: boolean 
  } {
    if (!this.lastValidLandmarks) {
      // First frame or lost tracking reset
      if (isValid) {
        this.lastValidLandmarks = [...currentLandmarks];
        this.missingFrames = 0;
        return { landmarks: currentLandmarks, isEstimated: false };
      }
      return { landmarks: null, isEstimated: false };
    }

    // Determine how "good" this new frame is overall?
    // We will use the `isValid` flag to determine if we should even consider this frame,
    // but applying interpolation based on a "Global Confidence".
    
    if (!isValid) {
        // Lost track completely
        this.missingFrames++;
        if (this.missingFrames <= this.maxMissingFrames) {
            return { landmarks: this.lastValidLandmarks, isEstimated: true };
        }
        return { landmarks: null, isEstimated: false };
    }

    this.missingFrames = 0;

    // "Smart" Interpolation
    // We calculate a mixing factor based on average visibility of key joints (Hips, Knees, Ankles)
    const keyIndices = [23, 24, 25, 26, 27, 28]; // Hips, Knees, Ankles
    const avgVis = keyIndices.reduce((acc, idx) => acc + (currentLandmarks[idx]?.visibility || 0), 0) / keyIndices.length;

    let t = 1.0;
    if (avgVis >= this.HIGH_CONFIDENCE) {
        t = 1.0; // Trust current
    } else if (avgVis <= this.LOW_CONFIDENCE) {
        t = 0.1; // Trust last heavily
    } else {
        // Interpolate 0.5 to 0.7 -> 0.0 to 1.0
        t = (avgVis - this.LOW_CONFIDENCE) / (this.HIGH_CONFIDENCE - this.LOW_CONFIDENCE);
    }

    // Apply interpolation
    const stabilizedLandmarks = currentLandmarks.map((curr, i) => {
        const prev = this.lastValidLandmarks![i];
        if (!prev) return curr;
        return lerpLandmark(prev, curr, t);
    });

    this.lastValidLandmarks = stabilizedLandmarks;
    return { landmarks: stabilizedLandmarks, isEstimated: t < 1.0 };
  }
}
