import { Landmark } from '../types';

export const POSE_LANDMARKS = {
  NOSE: 0,
  LEFT_EYE_INNER: 1,
  LEFT_EYE: 2,
  LEFT_EYE_OUTER: 3,
  RIGHT_EYE_INNER: 4,
  RIGHT_EYE: 5,
  RIGHT_EYE_OUTER: 6,
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  MOUTH_LEFT: 9,
  MOUTH_RIGHT: 10,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_PINKY: 17,
  RIGHT_PINKY: 18,
  LEFT_INDEX: 19,
  RIGHT_INDEX: 20,
  LEFT_THUMB: 21,
  RIGHT_THUMB: 22,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,
  RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
};

// Helper: Vector magnitude (2D) for screen-plane calculations
const magnitude2D = (dx: number, dy: number) => Math.sqrt(dx * dx + dy * dy);

/**
 * Calculates the angle (0-180 degrees) at point B formed by points A, B, and C.
 * Uses 3D vector dot product to account for depth (Z-axis).
 * Formula: θ = arccos( (BA • BC) / (|BA| * |BC|) )
 * 
 * Example: To get the elbow angle, pass (Shoulder, Elbow, Wrist).
 */
export const calculateAngle = (a: Landmark, b: Landmark, c: Landmark): number => {
  // Ensure Z exists (default to 0 if undefined)
  const az = a.z ?? 0;
  const bz = b.z ?? 0;
  const cz = c.z ?? 0;

  // Vector BA (B -> A)
  const v1 = {
    x: a.x - b.x,
    y: a.y - b.y,
    z: az - bz
  };

  // Vector BC (B -> C)
  const v2 = {
    x: c.x - b.x,
    y: c.y - b.y,
    z: cz - bz
  };

  // Dot Product
  const dot = (v1.x * v2.x) + (v1.y * v2.y) + (v1.z * v2.z);

  // Magnitudes (3D)
  const mag1 = Math.sqrt(v1.x * v1.x + v1.y * v1.y + v1.z * v1.z);
  const mag2 = Math.sqrt(v2.x * v2.x + v2.y * v2.y + v2.z * v2.z);

  // Edge Case: If any vector has 0 length (points are same), return 180 (straight line)
  if (mag1 === 0 || mag2 === 0) return 180;

  // Calculate Cosine
  let cosine = dot / (mag1 * mag2);

  // Clamp to [-1, 1] to prevent NaN
  cosine = Math.max(-1.0, Math.min(1.0, cosine));

  // Acos returns radians [0, PI], convert to degrees
  const angle = Math.acos(cosine) * (180.0 / Math.PI);
  
  return angle;
};

/**
 * Calculates the Euclidean distance between two landmarks.
 * NOTE: This relies on raw coordinates (0-1). For depth-invariant checks,
 * use getNormalizedDistance.
 */
export const getDistance = (a: Landmark, b: Landmark): number => {
  return magnitude2D(a.x - b.x, a.y - b.y);
};

/**
 * Calculates distance between A and B, normalized by the user's torso size.
 * This ensures the logic works whether the user is 1 meter or 5 meters away.
 * 
 * @param landmarks The full array of pose landmarks
 * @param a Point A
 * @param b Point B
 * @returns Ratio relative to torso height (e.g., 0.5 means half the torso length)
 */
export const getNormalizedDistance = (landmarks: Landmark[], a: Landmark, b: Landmark): number => {
  const leftShoulder = landmarks[POSE_LANDMARKS.LEFT_SHOULDER];
  const leftHip = landmarks[POSE_LANDMARKS.LEFT_HIP];
  const rightShoulder = landmarks[POSE_LANDMARKS.RIGHT_SHOULDER];
  const rightHip = landmarks[POSE_LANDMARKS.RIGHT_HIP];

  // Need core torso points to establish scale
  if (!leftShoulder || !leftHip || !rightShoulder || !rightHip) return 0;

  // Calculate Torso Height (Average of left and right side for robustness)
  const leftTorso = magnitude2D(leftShoulder.x - leftHip.x, leftShoulder.y - leftHip.y);
  const rightTorso = magnitude2D(rightShoulder.x - rightHip.x, rightShoulder.y - rightHip.y);
  const torsoScale = (leftTorso + rightTorso) / 2;

  // Avoid division by zero
  if (torsoScale < 0.01) return 0;

  const targetDist = magnitude2D(a.x - b.x, a.y - b.y);
  
  return targetDist / torsoScale;
};
