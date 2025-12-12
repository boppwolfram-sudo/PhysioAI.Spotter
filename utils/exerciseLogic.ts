
import { Landmark, TrackingMode, VisualContext } from '../types';
import { POSE_LANDMARKS, calculateAngle } from './geometry';
import { MovingAverage, ExponentialMovingAverage, LandmarkStabilizer, areLandmarksVisible } from './signal';

// Gold Standard Biomechanics Constants
const C = {
  STANDING_ANGLE: 120,        
  DESCENT_START_ANGLE: 115,   
  PARALLEL_ANGLE: 110,        
  DEEP_SQUAT_ANGLE: 65,       
  ASCENT_THRESHOLD: 3,        
  ANGLE_CHANGE_MIN: 3,        
  VISIBILITY_MIN: 0.5,      
  SMOOTHING_FRAMES: 5,        
  SPEED_MIN_MS: 500,          
  
  // Valgus Constants
  VALGUS_THRESHOLD_ON: 0.18,
  VALGUS_THRESHOLD_OFF: 0.12,
  
  // Lean Constants
  LEAN_THRESHOLD_INFO: 3,      
  LEAN_THRESHOLD_WARN: 5,      
  LEAN_THRESHOLD_CRIT: 15,     
  LEAN_SUDDEN_CHANGE: 5,       
  LEAN_DESCENT_CHANGE: 15,     
  SHIN_TORSO_DEVIATION: 15,

  // Asymmetry & Shift Constants
  ASYMMETRY_THRESHOLD_INFO: 8,
  ASYMMETRY_THRESHOLD_WARN: 15,
  ASYMMETRY_THRESHOLD_CRIT: 25,
  HIP_SHIFT_THRESHOLD: 0.05, 
};

// Feedback Priorities
const PRIORITY = {
    STATE: 0,   // "Go Lower", "Stand Tall" (Instant)
    HINT: 1,    // "Watch Lean" (Sticky 500ms)
    FAULT: 2,   // "Knees Out!" (Sticky 1000ms)
    SUCCESS: 3  // "Perfect Rep!" (Sticky 1500ms)
};

// --- Step 3: Fault Confirmation State Machine ---
type FaultState = 'CLEAR' | 'SUSPECTED' | 'CONFIRMED' | 'CLEARING';

class FaultDetector {
    public state: FaultState = 'CLEAR';
    private framesInState: number = 0;
    private framesBelowThreshold: number = 0; 

    constructor(
        private thresholdOn: number,
        private thresholdOff: number,
        private framesToConfirm: number = 5,
        private framesToClear: number = 3
    ) {}

    reset() {
        this.state = 'CLEAR';
        this.framesInState = 0;
        this.framesBelowThreshold = 0;
    }

    update(value: number): boolean {
        switch (this.state) {
            case 'CLEAR':
                if (value > this.thresholdOn) {
                    this.state = 'SUSPECTED';
                    this.framesInState = 1;
                    this.framesBelowThreshold = 0;
                }
                break;

            case 'SUSPECTED':
                if (value > this.thresholdOn) {
                    this.framesInState++;
                    this.framesBelowThreshold = 0;
                    if (this.framesInState >= this.framesToConfirm) {
                        this.state = 'CONFIRMED';
                        this.framesInState = 0;
                    }
                } else {
                    this.framesBelowThreshold++;
                    if (this.framesBelowThreshold >= 2) {
                        this.state = 'CLEAR';
                        this.framesInState = 0;
                    }
                }
                break;

            case 'CONFIRMED':
                if (value < this.thresholdOff) {
                    this.state = 'CLEARING';
                    this.framesInState = 1;
                }
                break;

            case 'CLEARING':
                if (value < this.thresholdOff) {
                    this.framesInState++;
                    if (this.framesInState >= this.framesToClear) {
                        this.state = 'CLEAR';
                        this.framesInState = 0;
                    }
                } else {
                    this.state = 'CONFIRMED';
                    this.framesInState = 0;
                }
                break;
        }

        return this.state === 'CONFIRMED' || this.state === 'CLEARING';
    }
}

export interface ExerciseState {
  phase: 'INITIALIZING' | 'NEUTRAL' | 'DESCENDING' | 'ASCENDING';
  angle: number;
  repCount: number;
  feedback: string;
  feedbackColor: string; 
  isGoodRep: boolean | null; 
  didFinishRep: boolean; 
  trackingMode: TrackingMode; 
  visualContext: VisualContext;
  repScore: number;       
  minAngleReached: number; 
  depthHit: boolean;      
  faults: string[];       
}

export class SquatMechanics {
  private state: 'INITIALIZING' | 'NEUTRAL' | 'DESCENDING' | 'ASCENDING' = 'INITIALIZING';
  private repCount: number = 0;
  private frameCounter: number = 0;
  
  // Signal Processing
  private angleSmoother: MovingAverage;
  private torsoAngleSmoother: MovingAverage; 
  private stabilizer: LandmarkStabilizer;
  private kneeHeightSmoother: MovingAverage;
  
  // Rep Tracking
  private minAngle: number = 180;
  private prevAngle: number = 180; 
  private maxAscentAngle: number = 0; 
  private hitDepth: boolean = false;
  private descentStartTime: number = 0;
  private baselineKneeY: number = 0.8; 
  
  // Valgus Calibration & Detection
  private kneeAnkleRatioBaseline: ExponentialMovingAverage; 
  private baselineRatio: number = 1.0; 
  private valgusDetector: FaultDetector; 
  private baselineFrameCount: number = 0;
  private baselineCalibrated: boolean = false;
  
  // Lean Detection
  private currentTorsoAngle: number = 0;
  private prevTorsoAngle: number = 0;
  private startDescentTorsoAngle: number = 0;
  private maxLeanExcess: number = 0; 
  private leanFaultType: 'NONE' | 'STATIC' | 'FALLING' | 'MISMATCH' | 'INSTABILITY' = 'NONE';
  private leanDetector: FaultDetector; 
  
  // Asymmetry & Shift Detection
  private maxLegAngleDiff: number = 0;
  private asymmetrySide: 'LEFT' | 'RIGHT' | 'NONE' = 'NONE'; 
  private hipCenterXStart: number | null = null;
  private hipWidthStart: number = 0;
  private hipShiftDetected: boolean = false;
  private hipShiftSide: 'LEFT' | 'RIGHT' | 'NONE' = 'NONE';
  private repHadAsymmetry: boolean = false;
  private repHadHipShift: boolean = false;
  private hipShiftDetector: FaultDetector;

  // Fault Tracking Flags
  private kneeValgus: boolean = false; 
  private repHadValgus: boolean = false; 
  private excessiveLean: boolean = false; 
  private leanInfo: boolean = false; 
  private repHadLeanFault: boolean = false; 
  private speedFault: boolean = false;
  
  // Feedback System (New Priority Logic)
  private feedbackLockUntil: number = 0;
  private feedbackPriority: number = 0;
  private feedbackMessage: string = "STAND STRAIGHT";
  private feedbackColor: string = "#3B82F6";
  private lastFeedback: string = "";
  private lastColor: string = "";
  
  // Score Tracking
  private lastRepScore: number = 0;
  private lastRepFaults: string[] = [];

  constructor() {
    this.angleSmoother = new MovingAverage(C.SMOOTHING_FRAMES); 
    this.torsoAngleSmoother = new MovingAverage(C.SMOOTHING_FRAMES);
    this.kneeHeightSmoother = new MovingAverage(30); 
    this.kneeAnkleRatioBaseline = new ExponentialMovingAverage(30); 
    this.stabilizer = new LandmarkStabilizer();
    
    // Initialize Fault Detectors with Hysteresis
    this.valgusDetector = new FaultDetector(C.VALGUS_THRESHOLD_ON, C.VALGUS_THRESHOLD_OFF, 5, 3);
    this.leanDetector = new FaultDetector(C.LEAN_THRESHOLD_WARN, C.LEAN_THRESHOLD_WARN - 2, 5, 3);
    // Hip Shift Detector: On at 0.05, Off at 0.03
    this.hipShiftDetector = new FaultDetector(C.HIP_SHIFT_THRESHOLD, C.HIP_SHIFT_THRESHOLD - 0.02, 4, 3);
  }

  reset() {
    this.state = 'INITIALIZING';
    this.frameCounter = 0;
    this.repCount = 0;
    this.minAngle = 180;
    this.prevAngle = 180;
    this.maxAscentAngle = 0;
    this.hitDepth = false;
    this.kneeValgus = false;
    this.repHadValgus = false;
    this.excessiveLean = false;
    this.leanInfo = false;
    this.repHadLeanFault = false;
    this.leanFaultType = 'NONE';
    this.maxLeanExcess = 0;
    this.speedFault = false;
    
    this.maxLegAngleDiff = 0;
    this.asymmetrySide = 'NONE';
    this.hipCenterXStart = null;
    this.hipWidthStart = 0;
    this.hipShiftDetected = false;
    this.hipShiftSide = 'NONE';
    this.repHadAsymmetry = false;
    this.repHadHipShift = false;
    
    this.angleSmoother.reset();
    this.torsoAngleSmoother.reset();
    this.stabilizer.reset();
    this.kneeHeightSmoother.reset();
    this.kneeAnkleRatioBaseline.reset();
    this.valgusDetector.reset();
    this.leanDetector.reset();
    this.hipShiftDetector.reset();
    this.baselineFrameCount = 0;
    this.baselineCalibrated = false;
    
    this.baselineRatio = 1.0;
    this.baselineKneeY = 0.8;
    this.lastRepScore = 0;
    this.lastRepFaults = [];
    
    // Reset Feedback
    this.feedbackLockUntil = 0;
    this.feedbackPriority = 0;
    this.feedbackMessage = "STAND STRAIGHT";
    this.feedbackColor = "#3B82F6";
    this.lastFeedback = "STAND STRAIGHT";
    this.lastColor = "#3B82F6";
  }

  /**
   * Sets feedback with a specific priority and duration.
   * Higher priority overrides lower priority.
   * Same priority overrides if the message is different or to extend duration.
   */
  private setPriorityFeedback(message: string, color: string, priority: number, durationMs: number) {
    const now = Date.now();
    
    // Check if we can override
    // 1. If currently locked by higher priority, ignore.
    if (now < this.feedbackLockUntil && priority < this.feedbackPriority) {
        return;
    }
    
    // 2. If same priority, or higher, or lock expired -> Apply
    this.feedbackMessage = message;
    this.feedbackColor = color;
    this.feedbackPriority = priority;
    this.feedbackLockUntil = now + durationMs;
  }

  private calculateRepScore(): { score: number, faults: string[] } {
    let score = 100;
    const faults: string[] = [];

    if (this.minAngle > C.PARALLEL_ANGLE) {
        score -= 50;
        faults.push("GO DEEPER");
    }
    if (this.repHadValgus) {
        score -= 20;
        faults.push("KNEES IN");
    }
    
    if (this.repHadAsymmetry) {
        if (this.maxLegAngleDiff > C.ASYMMETRY_THRESHOLD_CRIT) {
            score -= 20;
            faults.push(`IMBALANCE ${this.asymmetrySide === 'LEFT' ? 'L' : 'R'}`);
        } else if (this.maxLegAngleDiff > C.ASYMMETRY_THRESHOLD_WARN) {
            score -= 10;
            faults.push("ASYMMETRY");
        }
    }

    if (this.repHadHipShift) {
        score -= 15;
        faults.push("HIP SHIFT");
    }

    if (this.repHadLeanFault) {
        if (this.maxLeanExcess > C.LEAN_THRESHOLD_CRIT) {
             score -= 25; 
             faults.push("EXCESSIVE LEAN");
        } else if (this.leanFaultType === 'FALLING') {
             score -= 20;
             faults.push("CHEST FALLING");
        } else if (this.leanFaultType === 'MISMATCH') {
             score -= 15;
             faults.push("HIP DOMINANT");
        } else {
             score -= 10; 
             faults.push("CHEST UP");
        }
    }
    if (this.speedFault) {
        score -= 15;
        faults.push("TOO FAST");
    }

    return { 
        score: Math.max(0, score), 
        faults 
    };
  }

  update(rawLandmarks: Landmark[]): ExerciseState {
    const leftLegVisible = areLandmarksVisible(rawLandmarks, [POSE_LANDMARKS.LEFT_HIP, POSE_LANDMARKS.LEFT_KNEE, POSE_LANDMARKS.LEFT_ANKLE], C.VISIBILITY_MIN);
    const rightLegVisible = areLandmarksVisible(rawLandmarks, [POSE_LANDMARKS.RIGHT_HIP, POSE_LANDMARKS.RIGHT_KNEE, POSE_LANDMARKS.RIGHT_ANKLE], C.VISIBILITY_MIN);

    const { landmarks, isEstimated } = this.stabilizer.process(
        rawLandmarks, 
        leftLegVisible || rightLegVisible
    );

    if (!landmarks) {
        return {
            phase: this.state,
            angle: 180,
            repCount: this.repCount,
            feedback: "SHOW FULL BODY",
            feedbackColor: "#64748B",
            isGoodRep: null,
            didFinishRep: false,
            trackingMode: 'LOST',
            visualContext: { valgus: false, baselineKneeY: this.baselineKneeY, isDeep: false, lean: false, hipShift: false, asymmetry: false },
            repScore: this.lastRepScore,
            minAngleReached: 180,
            depthHit: false,
            faults: []
        };
    }

    // --- 1. CALCULATE METRICS FIRST (Moved up for State Machine) ---
    
    // Angle Calc
    let rawAngle = 180;
    let trackingMode: TrackingMode = 'OPTIMAL';
    let leftAngle = 180;
    let rightAngle = 180;

    if (isEstimated) {
        trackingMode = 'ESTIMATED';
        leftAngle = calculateAngle(landmarks[POSE_LANDMARKS.LEFT_HIP], landmarks[POSE_LANDMARKS.LEFT_KNEE], landmarks[POSE_LANDMARKS.LEFT_ANKLE]);
        rightAngle = calculateAngle(landmarks[POSE_LANDMARKS.RIGHT_HIP], landmarks[POSE_LANDMARKS.RIGHT_KNEE], landmarks[POSE_LANDMARKS.RIGHT_ANKLE]);
        rawAngle = (leftAngle + rightAngle) / 2;
    } 
    else if (leftLegVisible && rightLegVisible) {
        leftAngle = calculateAngle(landmarks[POSE_LANDMARKS.LEFT_HIP], landmarks[POSE_LANDMARKS.LEFT_KNEE], landmarks[POSE_LANDMARKS.LEFT_ANKLE]);
        rightAngle = calculateAngle(landmarks[POSE_LANDMARKS.RIGHT_HIP], landmarks[POSE_LANDMARKS.RIGHT_KNEE], landmarks[POSE_LANDMARKS.RIGHT_ANKLE]);
        rawAngle = (leftAngle + rightAngle) / 2;
        trackingMode = 'OPTIMAL';
        
        if (this.state === 'NEUTRAL' || this.state === 'INITIALIZING') {
             const avgKneeY = (landmarks[POSE_LANDMARKS.LEFT_KNEE].y + landmarks[POSE_LANDMARKS.RIGHT_KNEE].y) / 2;
             this.baselineKneeY = this.kneeHeightSmoother.update(avgKneeY);
        }
    } 
    else if (leftLegVisible || rightLegVisible) {
        const offset = leftLegVisible ? 0 : 1; 
        rawAngle = calculateAngle(landmarks[23+offset], landmarks[25+offset], landmarks[27+offset]);
        trackingMode = 'DEGRADED';
        leftAngle = rawAngle;
        rightAngle = rawAngle;
    }
    const angle = this.angleSmoother.update(rawAngle);

    // Torso Angle Calc
    const torsoVisible = areLandmarksVisible(landmarks, [11, 12, 23, 24], C.VISIBILITY_MIN);
    if (torsoVisible) {
       const leftHip = landmarks[POSE_LANDMARKS.LEFT_HIP];
       const rightHip = landmarks[POSE_LANDMARKS.RIGHT_HIP];
       const leftShoulder = landmarks[POSE_LANDMARKS.LEFT_SHOULDER];
       const rightShoulder = landmarks[POSE_LANDMARKS.RIGHT_SHOULDER];

       const midHipX = (leftHip.x + rightHip.x) / 2;
       const midHipY = (leftHip.y + rightHip.y) / 2;
       const midShoulderX = (leftShoulder.x + rightShoulder.x) / 2;
       const midShoulderY = (leftShoulder.y + rightShoulder.y) / 2;

       const verticalComp = midHipY - midShoulderY;
       const horizontalComp = Math.abs(midShoulderX - midHipX);
       let rawTorsoAngle = verticalComp > 0.01 ? Math.atan(horizontalComp / verticalComp) * (180 / Math.PI) : 90;
       
       const currentAngle = this.torsoAngleSmoother.update(rawTorsoAngle);
       this.currentTorsoAngle = currentAngle;
    }


    // --- 2. STATE MACHINE (Transitions & Resets) ---
    // Running this BEFORE Fault Detection ensures flags are reset correctly on transition,
    // and then immediately re-evaluated by Fault Detection in the same frame.
    
    const now = Date.now();
    let instantFeedback = "STAND STRAIGHT";
    let instantColor = "#3B82F6";
    let didFinishRep = false;
    
    this.frameCounter++;

    switch (this.state) {
      case 'INITIALIZING':
        instantFeedback = "STAND STRAIGHT";
        this.excessiveLean = false; 

        if (angle > C.STANDING_ANGLE) {
            this.state = 'NEUTRAL';
            this.frameCounter = 0;
            instantFeedback = "READY";
        } 
        else if (angle < C.DESCENT_START_ANGLE) {
            this.state = 'DESCENDING';
            this.frameCounter = 0;
            this.descentStartTime = now;
            this.minAngle = angle;
            instantFeedback = "GO LOWER";
        }
        else if (this.frameCounter > 30) {
            if (angle > C.STANDING_ANGLE - 10) { 
                 this.state = 'NEUTRAL';
                 this.frameCounter = 0;
                 instantFeedback = "CALIBRATED!";
                 this.setPriorityFeedback("CALIBRATED!", "#10B981", PRIORITY.SUCCESS, 2000);
            }
        }
        break;

      case 'NEUTRAL':
        if (angle < C.DESCENT_START_ANGLE) {
          this.state = 'DESCENDING';
          this.frameCounter = 0;
          this.descentStartTime = now;
          this.minAngle = 180;
          this.hitDepth = false;
          
          this.repHadValgus = false;
          this.kneeValgus = false;
          this.valgusDetector.reset(); 
          
          this.repHadLeanFault = false;
          this.excessiveLean = false; 
          this.leanInfo = false;
          this.maxLeanExcess = 0;
          this.startDescentTorsoAngle = this.currentTorsoAngle; 
          this.leanDetector.reset();
          
          this.speedFault = false;
          this.maxLegAngleDiff = 0;
          this.asymmetrySide = 'NONE';
          this.hipShiftDetected = false;
          this.repHadAsymmetry = false;
          this.repHadHipShift = false;
          this.hipShiftDetector.reset();
          
          const leftHip = landmarks[POSE_LANDMARKS.LEFT_HIP];
          const rightHip = landmarks[POSE_LANDMARKS.RIGHT_HIP];
          if (leftHip && rightHip) {
              this.hipCenterXStart = (leftHip.x + rightHip.x) / 2;
              this.hipWidthStart = Math.abs(leftHip.x - rightHip.x);
          }
          
          instantFeedback = "GO LOWER";
          instantColor = "#F59E0B"; 
        } else {
            instantFeedback = "STAND TALL";
            instantColor = "#3B82F6"; 
        }
        break;

      case 'DESCENDING':
        if (angle < this.minAngle) this.minAngle = angle;
        
        // Note: Fault detection runs after this block now, so we check flags from prev frame 
        // or re-evaluated flags in next frame cycle for feedback.
        // For Instant Feedback text, we rely on the flags.
        
        if (angle < C.PARALLEL_ANGLE) {
            this.hitDepth = true;
            instantFeedback = "GOOD DEPTH!";
            instantColor = "#10B981"; 
            if (angle < C.DEEP_SQUAT_ANGLE) {
                instantFeedback = "ATG DEEP!";
            }
            this.setPriorityFeedback(instantFeedback, instantColor, PRIORITY.SUCCESS, 1500);
        } else {
            instantFeedback = "LOWER...";
            instantColor = "#F59E0B"; 
        }
        
        if (angle > this.minAngle + C.ASCENT_THRESHOLD && this.minAngle < C.DESCENT_START_ANGLE) {
            this.state = 'ASCENDING';
            this.frameCounter = 0;
            this.maxAscentAngle = angle; 
            const duration = now - this.descentStartTime;
            if (duration < C.SPEED_MIN_MS) { 
                this.speedFault = true;
            }
        }
        break;

      case 'ASCENDING':
        this.maxAscentAngle = Math.max(this.maxAscentAngle, angle);
        
        if (angle < C.STANDING_ANGLE && this.frameCounter > 5 && (this.maxAscentAngle - angle) > C.ANGLE_CHANGE_MIN) {
            this.state = 'DESCENDING';
            this.frameCounter = 0;
            this.repCount++;
            didFinishRep = true;

            const result = this.calculateRepScore();
            this.lastRepScore = result.score;
            this.lastRepFaults = result.faults;

            this.descentStartTime = now;
            this.minAngle = angle;
            this.excessiveLean = false;
            this.leanInfo = false;
            this.startDescentTorsoAngle = this.currentTorsoAngle; 
            
            const leftHip = landmarks[POSE_LANDMARKS.LEFT_HIP];
            const rightHip = landmarks[POSE_LANDMARKS.RIGHT_HIP];
            if (leftHip && rightHip) {
               this.hipCenterXStart = (leftHip.x + rightHip.x) / 2;
            }
            this.maxLegAngleDiff = 0;
            
            if (!this.hitDepth) {
                this.setPriorityFeedback("GO LOWER (PUMP)", "#EF4444", PRIORITY.FAULT, 1500);
            } else {
                this.setPriorityFeedback("KEEP PUMPING", "#10B981", PRIORITY.SUCCESS, 1500);
            }
            this.hitDepth = false;
            this.speedFault = false;
        } 
        else {
            instantFeedback = "DRIVE UP";
            instantColor = "#10B981";

            if (angle > C.STANDING_ANGLE) {
                this.state = 'NEUTRAL';
                this.frameCounter = 0;
                this.repCount++;
                didFinishRep = true; 
                
                const { score, faults } = this.calculateRepScore();
                this.lastRepScore = score;
                this.lastRepFaults = faults;

                let repMsg = "";
                let repColor = "";

                if (score >= 90) {
                    repMsg = "PERFECT REP!";
                    repColor = "#10B981"; 
                } else if (score >= 70) {
                    repMsg = "GOOD REP";
                    repColor = "#10B981"; 
                } else if (score >= 50) {
                    repMsg = "OKAY - WATCH FORM";
                    repColor = "#F59E0B"; 
                } else {
                    repMsg = "TRY AGAIN";
                    repColor = "#EF4444"; 
                }
                
                this.setPriorityFeedback(repMsg, repColor, PRIORITY.SUCCESS, 2000);
                
                instantFeedback = repMsg;
                instantColor = repColor;
            }
        }
        break;
    }


    // --- 3. FAULT DETECTION (Runs AFTER State Machine) ---
    // This ensures flags (repHadValgus, etc.) are calculated for the current state, 
    // even if the state just transitioned in this frame.
    
    // Knee Valgus
    if (leftLegVisible && rightLegVisible) {
        const leftKnee = landmarks[POSE_LANDMARKS.LEFT_KNEE];
        const rightKnee = landmarks[POSE_LANDMARKS.RIGHT_KNEE];
        const leftAnkle = landmarks[POSE_LANDMARKS.LEFT_ANKLE];
        const rightAnkle = landmarks[POSE_LANDMARKS.RIGHT_ANKLE];
        
        const kneeWidth = Math.abs(leftKnee.x - rightKnee.x);
        const ankleWidth = Math.max(0.01, Math.abs(leftAnkle.x - rightAnkle.x)); 
        const currentRatio = kneeWidth / ankleWidth;

        if (this.state === 'NEUTRAL' || this.state === 'INITIALIZING') {
            this.baselineFrameCount++;
            this.baselineRatio = this.kneeAnkleRatioBaseline.update(currentRatio);
            
            if (this.baselineFrameCount > 20) {
                this.baselineCalibrated = true;
            }
            
            this.valgusDetector.reset(); 
            this.kneeValgus = false;
        } else {
            if (this.baselineCalibrated) {
                const deviation = (this.baselineRatio - currentRatio) / this.baselineRatio;
                // Corrected geometric check: Knees caving IN
                const geometricConfirm = rightKnee.x < (rightAnkle.x - 0.02) || leftKnee.x > (leftAnkle.x + 0.02);
                
                const signal = geometricConfirm ? deviation : 0;
                this.kneeValgus = this.valgusDetector.update(signal);
                if (this.kneeValgus) {
                    this.repHadValgus = true;
                    this.setPriorityFeedback("KNEES OUT!", "#EF4444", PRIORITY.FAULT, 1000);
                }
            }
        }
    }
    
    // Asymmetry & Hip Shift
    if (trackingMode === 'OPTIMAL' && (this.state === 'DESCENDING' || this.state === 'ASCENDING')) {
        const diff = Math.abs(leftAngle - rightAngle);
        if (diff > this.maxLegAngleDiff) {
            this.maxLegAngleDiff = diff;
            if (diff > C.ASYMMETRY_THRESHOLD_INFO) {
                 this.asymmetrySide = leftAngle > rightAngle ? 'LEFT' : 'RIGHT';
            }
        }
        if (this.maxLegAngleDiff > C.ASYMMETRY_THRESHOLD_WARN) {
            this.repHadAsymmetry = true;
            const side = this.asymmetrySide === 'LEFT' ? 'L' : 'R';
            this.setPriorityFeedback(`EVEN OUT ${side}!`, "#F59E0B", PRIORITY.FAULT, 1000);
        }

        const leftHip = landmarks[POSE_LANDMARKS.LEFT_HIP];
        const rightHip = landmarks[POSE_LANDMARKS.RIGHT_HIP];
        if (this.hipCenterXStart !== null && this.hipWidthStart > 0) {
            const currentHipX = (leftHip.x + rightHip.x) / 2;
            const shift = Math.abs(currentHipX - this.hipCenterXStart);
            const normalizedShift = shift / this.hipWidthStart;
            
            // Smoothed Shift Detection
            if (this.hipShiftDetector.update(normalizedShift)) {
                this.hipShiftDetected = true;
                this.repHadHipShift = true;
                this.hipShiftSide = currentHipX > this.hipCenterXStart ? 'RIGHT' : 'LEFT'; 
                this.setPriorityFeedback("CENTER HIPS!", "#F59E0B", PRIORITY.FAULT, 1000);
            } else {
                this.hipShiftDetected = false;
            }
        }
    }

    // Torso Lean Fault Logic
    if (torsoVisible) {
       let excessLean = 0;
       this.leanInfo = false; 
       
       const acceptableLean = 10 + ((180 - angle) * 0.375);
       excessLean = Math.max(0, this.currentTorsoAngle - acceptableLean);
       this.maxLeanExcess = Math.max(this.maxLeanExcess, excessLean);

       let isFaulty = false;
       let detectedFaultType: 'NONE' | 'STATIC' | 'FALLING' | 'MISMATCH' | 'INSTABILITY' = 'NONE';
       
       const isStaticFault = this.leanDetector.update(excessLean);
       
       // Falling Lean Check (Only relevant in Descending)
       if (this.state === 'DESCENDING') {
            if (this.currentTorsoAngle - this.startDescentTorsoAngle > C.LEAN_DESCENT_CHANGE) {
                detectedFaultType = 'FALLING';
                isFaulty = true;
            }
       }

       // Priority 1: STATIC (Critical Form Failure) - overrides falling
       if (isStaticFault) {
           detectedFaultType = 'STATIC';
           isFaulty = true;
       } else if (excessLean > C.LEAN_THRESHOLD_INFO) {
           this.leanInfo = true;
       }

       // Priority 2: INSTABILITY
       if (Math.abs(this.currentTorsoAngle - this.prevTorsoAngle) > C.LEAN_SUDDEN_CHANGE) {
           if (!isFaulty) { 
               detectedFaultType = 'INSTABILITY';
               isFaulty = true;
           }
       }

       // Priority 3: MISMATCH
       if (leftLegVisible && rightLegVisible) { 
            const midKneeX = (landmarks[POSE_LANDMARKS.LEFT_KNEE].x + landmarks[POSE_LANDMARKS.RIGHT_KNEE].x) / 2;
            const midKneeY = (landmarks[POSE_LANDMARKS.LEFT_KNEE].y + landmarks[POSE_LANDMARKS.RIGHT_KNEE].y) / 2;
            const midAnkleX = (landmarks[POSE_LANDMARKS.LEFT_ANKLE].x + landmarks[POSE_LANDMARKS.RIGHT_ANKLE].x) / 2;
            const midAnkleY = (landmarks[POSE_LANDMARKS.LEFT_ANKLE].y + landmarks[POSE_LANDMARKS.RIGHT_ANKLE].y) / 2;
            const shinVert = midAnkleY - midKneeY;
            const shinHorz = Math.abs(midKneeX - midAnkleX);
            const shinAngle = shinVert > 0.01 ? Math.atan(shinHorz / shinVert) * (180 / Math.PI) : 0;
            
            if ((this.currentTorsoAngle - shinAngle) > C.SHIN_TORSO_DEVIATION) {
                if (!isFaulty) {
                    detectedFaultType = 'MISMATCH';
                    isFaulty = true;
                }
            }
       }

       if (isFaulty) {
           this.leanFaultType = detectedFaultType;
           this.excessiveLean = true;
           this.repHadLeanFault = true;
           
           if (this.leanFaultType === 'FALLING') {
                this.setPriorityFeedback("CONTROL CHEST!", "#EF4444", PRIORITY.FAULT, 1000);
            } else if (this.leanFaultType === 'MISMATCH') {
                this.setPriorityFeedback("ALIGN SHINS!", "#F59E0B", PRIORITY.FAULT, 1000);
            } else if (excessLean > C.LEAN_THRESHOLD_CRIT) {
                this.setPriorityFeedback("CHEST UP NOW!", "#EF4444", PRIORITY.FAULT, 1000);
            } else {
                this.setPriorityFeedback("CHEST UP", "#F59E0B", PRIORITY.FAULT, 1000);
            }
       } else {
           this.excessiveLean = false;
           if (this.leanInfo) {
                this.setPriorityFeedback("WATCH LEAN", "#60A5FA", PRIORITY.HINT, 500);
           }
       }
       this.prevTorsoAngle = this.currentTorsoAngle;
    }

    this.prevAngle = angle;
    
    // --- FINAL FEEDBACK SELECTION ---
    let finalFeedback = instantFeedback;
    let finalColor = instantColor;
    
    if (now < this.feedbackLockUntil) {
        finalFeedback = this.feedbackMessage;
        finalColor = this.feedbackColor;
    } else {
        this.feedbackPriority = PRIORITY.STATE;
    }
    
    this.lastFeedback = finalFeedback;
    this.lastColor = finalColor;

    return {
        phase: this.state,
        angle,
        repCount: this.repCount,
        feedback: finalFeedback,
        feedbackColor: finalColor,
        isGoodRep: this.lastRepScore >= 70, 
        didFinishRep,
        trackingMode,
        visualContext: {
            valgus: this.kneeValgus, 
            baselineKneeY: this.baselineKneeY,
            isDeep: this.hitDepth,
            lean: this.excessiveLean,
            hipShift: this.hipShiftDetected,
            asymmetry: this.maxLegAngleDiff > C.ASYMMETRY_THRESHOLD_WARN
        },
        repScore: this.lastRepScore,
        minAngleReached: this.minAngle,
        depthHit: this.hitDepth,
        faults: this.lastRepFaults
    };
  }
}
