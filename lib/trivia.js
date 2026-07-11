// Open Trivia DB category IDs (https://opentdb.com/api_config.php), matched
// against free-text topics the LLM passes through from what the user said.
const CATEGORY_KEYWORDS = [
  [/\bboard game/i, 16],
  [/\bmovie|\bfilm/i, 11],
  [/\bmusical|\btheatre|\btheater/i, 13],
  [/\bmusic/i, 12],
  [/\btv|\btelevision/i, 14],
  [/\bvideo game|\bgaming/i, 15],
  [/\bcomputer|\btech/i, 18],
  [/\bmath/i, 19],
  [/\bmyth/i, 20],
  [/\bsport/i, 21],
  [/\bgeography|\bworld\b/i, 22],
  [/\bhistory/i, 23],
  [/\bpolitic/i, 24],
  [/\bart\b/i, 25],
  [/\bcelebrit/i, 26],
  [/\banimal/i, 27],
  [/\bcar\b|\bvehicle/i, 28],
  [/\bcomic/i, 29],
  [/\bgadget/i, 30],
  [/\banime|\bmanga/i, 31],
  [/\bcartoon/i, 32],
  [/\bbook/i, 10],
  [/\bscience|\bnature/i, 17],
  [/\bgeneral knowledge/i, 9],
];

function matchCategory(topic) {
  if (!topic || typeof topic !== "string") return null;
  for (const [pattern, id] of CATEGORY_KEYWORDS) {
    if (pattern.test(topic)) return id;
  }
  return null;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fetches one multiple-choice question from Open Trivia DB. Uses url3986
// encoding so answers decode cleanly with decodeURIComponent — Open Trivia
// DB's default encoding is raw HTML entities, which would need a separate
// entity-decoding pass.
async function fetchTriviaQuestion(topic, _retriedAfterRateLimit) {
  const categoryId = matchCategory(topic);
  const params = new URLSearchParams({ amount: "1", type: "multiple", encode: "url3986" });
  if (categoryId) params.set("category", String(categoryId));

  const res = await fetch(`https://opentdb.com/api.php?${params.toString()}`);
  if (res.status === 429 && !_retriedAfterRateLimit) {
    // Open Trivia DB allows ~1 request per 5s per IP — wait it out once.
    await sleep(5500);
    return fetchTriviaQuestion(topic, true);
  }
  if (!res.ok) throw new Error(`Open Trivia DB request failed (${res.status})`);
  const data = await res.json();

  // response_code 1 = no results for that category — fall back to any category.
  if (data.response_code !== 0 || !data.results || data.results.length === 0) {
    if (categoryId) return fetchTriviaQuestion(undefined);
    throw new Error("Open Trivia DB returned no questions");
  }

  const item = data.results[0];
  const decode = (s) => decodeURIComponent(s);

  const question = decode(item.question);
  const correctAnswer = decode(item.correct_answer);
  const incorrectAnswers = item.incorrect_answers.map(decode);

  const options = shuffle([correctAnswer, ...incorrectAnswers]).map((label, i) => ({
    id: `opt_${i + 1}`,
    label,
  }));
  const correctOption = options.find((o) => o.label === correctAnswer);

  return {
    category: decode(item.category),
    difficulty: item.difficulty,
    question,
    options,
    correct_option_id: correctOption.id,
  };
}

module.exports = { fetchTriviaQuestion };
