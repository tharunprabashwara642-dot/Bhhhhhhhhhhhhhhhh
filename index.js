async function fetchGeminiRotating(urlBuilder, options) {
  const attempts = Math.max(API_KEYS.length, 1);
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const key = nextKey();
    if (!key) throw new Error("No Gemini API key configured");
    try {
      const res = await fetch(urlBuilder(key), options);
      const data = await res.json();
      
      // Rate limit - wait and retry with same key
      if (res.status === 429) {
        console.error(`⚠️ Key ...${key.slice(-4)} rate-limited, waiting 10s...`);
        await new Promise(r => setTimeout(r, 10000));
        // Try the SAME key again (not rotate)
        i--;
        continue;
      }
      
      if (!res.ok && res.status >= 500) {
        console.error(`⚠️ Key ...${key.slice(-4)} server error ${res.status}, waiting 5s...`);
        await new Promise(r => setTimeout(r, 5000));
        i--;
        continue;
      }
      return data;
    } catch (e) {
      lastErr = e;
      // Network error - wait and retry
      if (e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT') {
        console.error(`⚠️ Network error, waiting 3s...`);
        await new Promise(r => setTimeout(r, 3000));
        i--;
        continue;
      }
    }
  }
  throw lastErr || new Error("All Gemini API keys failed");
}