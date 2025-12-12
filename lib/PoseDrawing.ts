
import { Landmark, VisualContext } from '../types';
import { POSE_LANDMARKS } from '../utils/geometry';

// Access MediaPipe global connections
const getConnections = () => {
    return window.POSE_CONNECTIONS || [];
};

/**
 * Draws the skeleton with line thickness based on Z-depth.
 * Closer limbs appear thicker.
 * NOTE: Applies Manual Mirroring (1-x) to align with flipped video.
 */
export const drawBiomechanicalSkeleton = (
  ctx: CanvasRenderingContext2D, 
  landmarks: Landmark[]
) => {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  const connections = getConnections();

  // 1. Draw Connectors (Bones)
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  connections.forEach(([startIdx, endIdx]: [number, number]) => {
    const start = landmarks[startIdx];
    const end = landmarks[endIdx];
    
    if (!start || !end || (start.visibility || 0) < 0.5 || (end.visibility || 0) < 0.5) return;

    // Calculate Average Depth (Z) for the bone
    const avgZ = (start.z + end.z) / 2;
    const depthScale = Math.max(0.5, 2.0 - (avgZ * 5)); 
    const lineWidth = 3 * depthScale;

    ctx.beginPath();
    // Manual Mirroring: (1 - x)
    ctx.moveTo((1 - start.x) * width, start.y * height);
    ctx.lineTo((1 - end.x) * width, end.y * height);
    ctx.lineWidth = lineWidth;
    
    if (startIdx >= 11 && startIdx <= 24 && endIdx >= 11 && endIdx <= 24) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'; // Torso/Core
    } else if (startIdx >= 23) {
        ctx.strokeStyle = 'rgba(16, 185, 129, 0.8)'; // Legs (Emerald)
    } else {
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.8)'; // Arms (Slate)
    }
    
    ctx.stroke();
  });

  // 2. Draw Landmarks (Joints)
  landmarks.forEach((lm) => {
    if ((lm.visibility || 0) < 0.5) return;
    
    // Manual Mirroring
    const x = (1 - lm.x) * width;
    const y = lm.y * height;
    
    const radius = Math.max(2, 5 * (1 - lm.z * 3));
    
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, 2 * Math.PI);
    ctx.fillStyle = '#ef4444'; // Red Joints
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.stroke();
  });
};

/**
 * Visualizes a "Floor" at the calibrated knee height.
 */
export const drawDepthFloor = (
    ctx: CanvasRenderingContext2D,
    landmarks: Landmark[],
    mechanics: VisualContext
) => {
    if (!mechanics.baselineKneeY || mechanics.baselineKneeY === 0) return;

    const width = ctx.canvas.width;
    const height = ctx.canvas.height;
    
    const floorY = mechanics.baselineKneeY * height;

    // Draw Dashed Line
    ctx.save();
    ctx.beginPath();
    ctx.setLineDash([10, 10]);
    ctx.moveTo(0, floorY);
    ctx.lineTo(width, floorY);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.5)'; // Blue semi-transparent
    ctx.stroke();
    
    // Label "DEPTH TARGET" (Text is drawn normally, so it's readable)
    ctx.fillStyle = 'rgba(59, 130, 246, 0.8)';
    ctx.font = '10px sans-serif';
    ctx.fillText("DEPTH TARGET", 10, floorY - 5);

    // Indicator on Hip Center
    const leftHip = landmarks[POSE_LANDMARKS.LEFT_HIP];
    const rightHip = landmarks[POSE_LANDMARKS.RIGHT_HIP];
    
    if (leftHip && rightHip) {
        // Manual Mirroring for Center Point
        const avgX = (leftHip.x + rightHip.x) / 2;
        const hipX = (1 - avgX) * width;
        const hipY = ((leftHip.y + rightHip.y) / 2) * height;

        const isBelowFloor = hipY > floorY;
        
        ctx.beginPath();
        ctx.arc(hipX, hipY, 8, 0, 2 * Math.PI);
        ctx.fillStyle = isBelowFloor ? '#10B981' : '#F59E0B'; 
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#fff';
        ctx.setLineDash([]); 
        ctx.stroke();
    }
    
    ctx.restore();
};

/**
 * Draws a cone indicating safe torso lean angle.
 */
export const drawTorsoLeanCone = (
    ctx: CanvasRenderingContext2D,
    landmarks: Landmark[],
    mechanics?: VisualContext
) => {
    const leftHip = landmarks[POSE_LANDMARKS.LEFT_HIP];
    const rightHip = landmarks[POSE_LANDMARKS.RIGHT_HIP];
    const leftShoulder = landmarks[POSE_LANDMARKS.LEFT_SHOULDER];
    const rightShoulder = landmarks[POSE_LANDMARKS.RIGHT_SHOULDER];

    if (!leftHip || !rightHip || !leftShoulder || !rightShoulder) return;

    const width = ctx.canvas.width;
    const height = ctx.canvas.height;

    // Manual Mirroring for coordinates
    const hipXRaw = (leftHip.x + rightHip.x) / 2;
    const hipX = (1 - hipXRaw) * width;
    const hipY = ((leftHip.y + rightHip.y) / 2) * height;
    
    const shoulderXRaw = (leftShoulder.x + rightShoulder.x) / 2;
    const shoulderX = (1 - shoulderXRaw) * width;
    const shoulderY = ((leftShoulder.y + rightShoulder.y) / 2) * height;

    // Draw Safe Cone 
    ctx.save();
    ctx.translate(hipX, hipY);
    
    // Wedge
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 100, (Math.PI / 180) * 225, (Math.PI / 180) * 315); 
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.fill();
    
    // Actual Torso Line
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(shoulderX - hipX, shoulderY - hipY);
    ctx.lineWidth = 3;
    
    // Calculate angle locally for fallback
    // Note: Since we mirrored X, the angle direction flips horizontally.
    // Standard upright is -90. Leaning "Forward" in a squat usually means head X < hip X (if facing left) or head X > hip X (if facing right).
    // The "Safe Cone" 225 to 315 is +/- 45 deg from Up (-90 or 270). This is symmetric.
    // So mirroring X doesn't invalidate the symmetric cone check.
    
    const dx = shoulderX - hipX;
    const dy = shoulderY - hipY; 
    const angleRad = Math.atan2(dy, dx); 
    const angleDeg = angleRad * (180 / Math.PI);
    
    const isBadLeanLocal = angleDeg < -135 || angleDeg > -45;
    const isBadLean = mechanics?.lean ?? isBadLeanLocal;
    
    ctx.strokeStyle = isBadLean ? '#EF4444' : '#FFFFFF';
    ctx.stroke();
    
    ctx.restore();
};

/**
 * Draws pulsing arrows pointing outward from knees when Valgus is detected.
 */
export const drawValgusArrows = (
    ctx: CanvasRenderingContext2D,
    landmarks: Landmark[],
    mechanics: VisualContext
) => {
    if (!mechanics.valgus) return;

    const width = ctx.canvas.width;
    const height = ctx.canvas.height;
    const time = Date.now() / 200; 
    const offset = (Math.sin(time) * 5) + 10; 

    [POSE_LANDMARKS.LEFT_KNEE, POSE_LANDMARKS.RIGHT_KNEE].forEach((idx, i) => {
        const knee = landmarks[idx];
        if (!knee) return;
        
        // Manual Mirroring
        const kx = (1 - knee.x) * width;
        const ky = knee.y * height;
        
        // Direction logic:
        // i=0 is LEFT_KNEE. In mirror view, this appears on the Left side of screen.
        // We want to push it "Out" (Left, -X).
        // i=1 is RIGHT_KNEE. In mirror view, this appears on Right side of screen.
        // We want to push it "Out" (Right, +X).
        // Original logic: i=0 -> -1. i=1 -> 1. 
        // This holds true for the mirrored screen positions too.
        
        const direction = i === 0 ? -1 : 1;
        
        ctx.save();
        ctx.fillStyle = '#EF4444';
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2;
        
        // Draw Arrow
        ctx.beginPath();
        const startX = kx + (direction * 10);
        const endX = kx + (direction * (40 + offset));
        
        ctx.moveTo(startX, ky);
        ctx.lineTo(endX, ky);
        ctx.lineTo(endX - (direction * 10), ky - 5);
        ctx.moveTo(endX, ky);
        ctx.lineTo(endX - (direction * 10), ky + 5);
        
        ctx.stroke();

        // Text Label (Readable because canvas not flipped)
        ctx.font = "bold 12px sans-serif";
        ctx.textAlign = i === 0 ? "right" : "left";
        ctx.fillStyle = "#EF4444";
        ctx.fillText("PUSH OUT", endX + (direction * 5), ky + 4);

        ctx.restore();
    });
};
