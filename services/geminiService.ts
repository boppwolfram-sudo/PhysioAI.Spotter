import { GoogleGenAI } from "@google/genai";
import { AnalysisResult } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export const analyzeFormWithGemini = async (base64Image: string, context?: string): Promise<AnalysisResult> => {
  try {
    const model = "gemini-2.5-flash";
    const prompt = `
      You are an expert Physiotherapist and Personal Trainer.
      
      I have provided a composite image of a person performing an exercise. 
      The image includes a skeletal overlay (MediaPipe) to show exact joint positions.
      
      ADDITIONAL TELEMETRY DATA:
      ${context || "No specific telemetry provided."}

      Please analyze the form using both the image and the provided telemetry:
      1. Identify the exercise being performed.
      2. Analyze the skeletal alignment from the image.
      3. Correlate with telemetry (e.g., if telemetry says "Knees In", look for Valgus in image).
      4. Determine if the form is GOOD or BAD.
      5. Provide specific, brief, actionable correction if needed.

      Respond in JSON format:
      {
        "isGoodForm": boolean,
        "feedback": "string (max 2 sentences)",
        "correction": "string (optional, key correction tip)"
      }
    `;

    const response = await ai.models.generateContent({
      model: model,
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: "image/jpeg",
              data: base64Image.split(",")[1], // Remove data:image/jpeg;base64, prefix
            },
          },
          { text: prompt },
        ],
      },
      config: {
        responseMimeType: "application/json",
      },
    });

    const text = response.text;
    if (!text) throw new Error("No response from Gemini");

    return JSON.parse(text) as AnalysisResult;
  } catch (error) {
    console.error("Gemini Analysis Error:", error);
    return {
      isGoodForm: false,
      feedback: "Failed to analyze form. Please try again.",
      correction: "Check internet connection or API key.",
    };
  }
};
