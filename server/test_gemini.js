const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

async function run() {
  try {
    const result = await model.generateContent("Hi");
    console.log("RESULT:", result.response.text());
  } catch (e) {
    console.error("ERROR:", e.message);
  }
}
run();
