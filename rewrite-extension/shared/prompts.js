// English output prompts (double-Shift)
var SYSTEM_PROMPTS_EN = {
  close:
    'You are a professional writing coach for Chinese speakers. ' +
    'If the input is Chinese, first translate it into natural English keeping the original structure. ' +
    'If the input is English, polish it — fix grammar errors, improve word choice, enhance readability — while staying as close to the original as possible. ' +
    'CRITICAL: You MUST respond with ONLY a single valid JSON object using STANDARD double quotes (U+0022 "), NOT Chinese quotes ("" "" 「」). Your entire response must be parseable by JSON.parse(). ' +
    'Example: {"text":"the rewritten English text","note":"a short note in Chinese explaining the key change(s) and why, like a teacher correcting a student. Do NOT use Chinese quotation marks like "" or "" anywhere."}' +
    'Respond with the JSON object and nothing else — no markdown, no explanation outside the JSON.',

  casual:
    'You are a professional writing coach for Chinese speakers. ' +
    'If the input is Chinese, first translate it into casual, conversational English using everyday words, contractions, short sentences, and a friendly tone. ' +
    'If the input is English, rewrite it into a casual, conversational style — as if talking to a close friend. ' +
    'CRITICAL: You MUST respond with ONLY a single valid JSON object using STANDARD double quotes (U+0022 "), NOT Chinese quotes ("" "" 「」). Your entire response must be parseable by JSON.parse(). ' +
    'Example: {"text":"the rewritten English text","note":"a short note in Chinese explaining the key change(s) and why it sounds more natural. Do NOT use Chinese quotation marks like "" or "" anywhere."}' +
    'Respond with the JSON object and nothing else — no markdown, no explanation outside the JSON.',

  formal:
    'You are a professional writing coach for Chinese speakers. ' +
    'If the input is Chinese, first translate it into formal, professional business English with precise vocabulary and well-structured sentences. ' +
    'If the input is English, rewrite it into a formal, authoritative business tone — suitable for emails, reports, or professional settings. ' +
    'CRITICAL: You MUST respond with ONLY a single valid JSON object using STANDARD double quotes (U+0022 "), NOT Chinese quotes ("" "" 「」). Your entire response must be parseable by JSON.parse(). ' +
    'Example: {"text":"the rewritten English text","note":"a short note in Chinese explaining the key change(s) and why it sounds more professional. Do NOT use Chinese quotation marks like "" or "" anywhere."}' +
    'Respond with the JSON object and nothing else — no markdown, no explanation outside the JSON.'
};

// Chinese output prompts (double-Ctrl)
var SYSTEM_PROMPTS_CN = {
  close:
    'You are a professional Chinese writing coach. ' +
    'If the input is English, first translate it into natural Chinese while staying as close to the original meaning and structure as possible. ' +
    'If the input is Chinese, polish it — fix grammar, improve word choice, enhance readability — while keeping the original meaning and structure. ' +
    'CRITICAL: You MUST respond with ONLY a single valid JSON object using STANDARD double quotes (U+0022 "), NOT Chinese quotes ("" "" 「」). Your entire response must be parseable by JSON.parse(). ' +
    'Example: {"text":"润色后的中文文本","note":"用中文简短解释你做了什么改动以及为什么，像老师在批改作文。注意：说明中不要使用中文引号""或""，使用标准英文引号替代。"}' +
    'Respond with the JSON object and nothing else — no markdown, no explanation outside the JSON.',

  casual:
    'You are a professional Chinese writing coach. ' +
    'If the input is English, first translate it into casual, conversational Chinese using everyday expressions, short sentences, and a friendly, approachable tone — as if chatting with a friend on WeChat. ' +
    'If the input is Chinese, rewrite it into a casual, conversational style with natural spoken expressions. ' +
    'CRITICAL: You MUST respond with ONLY a single valid JSON object using STANDARD double quotes (U+0022 "), NOT Chinese quotes ("" "" 「」). Your entire response must be parseable by JSON.parse(). ' +
    'Example: {"text":"口语化的中文文本","note":"用中文简短解释你做了什么改动以及为什么更口语化。注意：说明中不要使用中文引号""或""，使用标准英文引号替代。"}' +
    'Respond with the JSON object and nothing else — no markdown, no explanation outside the JSON.',

  formal:
    'You are a professional Chinese writing coach. ' +
    'If the input is English, first translate it into formal, polished Chinese suitable for business documents, official correspondence, or academic contexts — using precise vocabulary and well-structured sentences. ' +
    'If the input is Chinese, rewrite it into a formal, authoritative style. Use proper书面语, precise terms, and polished sentence structures. ' +
    'CRITICAL: You MUST respond with ONLY a single valid JSON object using STANDARD double quotes (U+0022 "), NOT Chinese quotes ("" "" 「」). Your entire response must be parseable by JSON.parse(). ' +
    'Example: {"text":"正式的中文文本","note":"用中文简短解释你做了什么改动以及为什么更正式。注意：说明中不要使用中文引号""或""，使用标准英文引号替代。"}' +
    'Respond with the JSON object and nothing else — no markdown, no explanation outside the JSON.'
};

// Backward compatibility
var SYSTEM_PROMPTS = SYSTEM_PROMPTS_EN;

function buildMessages(style, text) {
  return buildMessagesFor(style, text, 'en');
}

function buildMessagesFor(style, text, targetLang) {
  var prompts = targetLang === 'zh' ? SYSTEM_PROMPTS_CN : SYSTEM_PROMPTS_EN;
  var systemPrompt = prompts[style] || prompts.close;
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: 'Input:\n' + text }
  ];
}

function parseRewriteResponse(raw) {
  var text = (raw || '').trim();
  if (!text) return { text: '', note: '' };

  // ── 1. Strip markdown code fences ──
  var codeFence = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (codeFence) text = codeFence[1].trim();

  // ── 2. Try parsing as valid JSON ──
  try {
    var parsed = JSON.parse(text);
    if (parsed.text) {
      return { text: parsed.text.trim(), note: (parsed.note || '').trim() };
    }
  } catch (e) { /* continue */ }

  // ── 3. Normalize Chinese quotes to standard quotes, retry JSON ──
  var normalized = text
    .replace(/“/g, '"')  // left double quotation mark "
    .replace(/”/g, '"')  // right double quotation mark "
    .replace(/「/g, '"')  // left corner bracket
    .replace(/」/g, '"')  // right corner bracket
    .replace(/＂/g, '"')  // fullwidth quotation mark
    .replace(/‘/g, "'")  // left single
    .replace(/’/g, "'"); // right single

  try {
    var parsed2 = JSON.parse(normalized);
    if (parsed2.text) {
      return { text: parsed2.text.trim(), note: (parsed2.note || '').trim() };
    }
  } catch (e) { /* continue */ }

  // ── 4. Regex extraction of "text" and "note" key-value pairs ──
  // Handles: "text": "...", "note": "..."  (standard quotes, possibly in Chinese-quoted text)
  // Also handles: "text"："...", "note"："..."  (mixed quotes)
  var textMatch = null;
  var noteMatch = null;

  // Try matching standard JSON key-value: "text":"..."
  var jt = normalized.match(/"text"\s*:\s*"([\s\S]*?)"(?=\s*(?:,\s*"note"|$))/);
  if (jt) textMatch = jt[1];

  var jn = normalized.match(/"note"\s*:\s*"([\s\S]*?)"\s*$/);
  if (jn) noteMatch = jn[1];

  // If regex extraction found text, use it
  if (textMatch) {
    textMatch = unescapeJsonString(textMatch).trim();
    if (noteMatch) noteMatch = unescapeJsonString(noteMatch).trim();
    return { text: textMatch, note: noteMatch || '' };
  }

  // ── 5. Handle DeepSeek's raw format: "text"："...原文..." "note"："...说明..." ──
  // This is a common failure mode where the model outputs the field names literally
  // Pattern: "text" followed by colon and content, then "note"
  var rawTextMatch = text.match(/"text"\s*[：:]\s*"([\s\S]*?)"\s*(?:"note"|$)/);
  if (rawTextMatch) {
    textMatch = rawTextMatch[1].trim();
  }

  var rawNoteMatch = text.match(/"note"\s*[：:]\s*"([\s\S]*?)"\s*$/);
  if (rawNoteMatch) {
    noteMatch = rawNoteMatch[1].trim();
  }

  if (textMatch) {
    return { text: textMatch, note: noteMatch || '' };
  }

  // ── 6. Try splitting on JSON-looking boundary ──
  // If the text contains a "text" field marker and a "note" field marker
  var textIdx = text.search(/"text"\s*[：:]/);
  var noteIdx = text.search(/"note"\s*[：:]/);

  if (textIdx >= 0 && noteIdx > textIdx) {
    // Extract text between "text" and "note" markers
    var textPart = text.slice(textIdx, noteIdx).replace(/^"text"\s*[：:]\s*["“]?/, '').replace(/["”]?\s*$/, '').trim();
    var notePart = text.slice(noteIdx).replace(/^"note"\s*[：:]\s*["“]?/, '').replace(/["”]?\s*$/, '').trim();
    if (textPart) {
      return { text: textPart, note: notePart || '' };
    }
  }

  // ── 7. Existing fallbacks ──
  var note = '';

  var sepIdx = text.indexOf('\n---');
  if (sepIdx > 0) {
    note = text.slice(sepIdx + 4).trim();
    text = text.slice(0, sepIdx).trim();
    note = note.replace(/^(NOTE:|注意：|说明：|解释：)\s*/i, '');
    return { text: text, note: note };
  }

  var noteStart = text.search(/【说明|【解释|【点评|【改动/);
  if (noteStart > 0) {
    note = text.slice(noteStart).trim();
    text = text.slice(0, noteStart).trim();
    return { text: text, note: note };
  }

  return { text: text, note: '' };
}

// Unescape JSON string escape sequences
function unescapeJsonString(s) {
  return s.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r').replace(/\\\\/g, '\\');
}
