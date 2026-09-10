// Pure helpers for the "Generate with AI" template feature (OpenRouter-backed).
// Kept network-free and deterministic on purpose so they're unit-testable without hitting
// OpenRouter - the route (routes/templates.js) owns the actual HTTP call and error handling.

const DEFAULT_MODEL = 'anthropic/claude-sonnet-5';

// Email clients (Outlook, Gmail, etc) strip <style> blocks and external stylesheets and don't
// reliably support flexbox/grid - the only markup that renders consistently everywhere is a
// simple table/div layout with every rule written as an inline style="" attribute. Without this,
// a model asked for "HTML" tends to hand back bare unstyled tags that look nothing like a real
// email template, so this is spelled out explicitly whenever type is html.
const HTML_STYLING_INSTRUCTIONS = 'Since this is a real HTML email (not a webpage), write fully ' +
  'self-contained markup: every rule as an inline style="..." attribute on the element it applies ' +
  'to - never a <style> block, <link>, class name, or external stylesheet, since most email ' +
  'clients strip those. Do not use flexbox or CSS grid (poor email client support) - use simple ' +
  'nested <div> or <table> layouts instead. Wrap the whole email in one outer container styled ' +
  'with a max-width around 600px, centered, a white or light background, a readable font-family ' +
  '(a plain sans-serif stack), body text around 15-16px with line-height around 1.6, and sensible ' +
  'padding so it does not look cramped. If there is a call to action, style it to look like a real ' +
  'button (background color, white text, padding, rounded corners) using inline styles, not a bare ' +
  '<a> tag. No JavaScript, no forms, no external images or fonts.';

function buildMessages({ prompt, tone, length, type }) {
  const toneLabel = tone || 'friendly';
  const lengthLabel = length || 'short';
  const isHtml = type === 'html';
  const typeLabel = isHtml ? 'HTML' : 'plain text';
  const system = [
    'You write cold-outreach email templates for a B2B recruiting/staffing SaaS company.',
    'Respond with ONLY a single JSON object (no markdown fences, no commentary) with exactly ' +
      'these keys: "name" (a short internal template name, under 8 words), "subject" (an email ' +
      `subject line), "body" (the email body as ${typeLabel}).`,
    'The body may use these merge tags where natural: {{first_name}}, {{last_name}}, {{company}}. ' +
      'Do not include an unsubscribe link, physical address, or footer - those are added ' +
      'automatically by the sending platform.',
    `Tone: ${toneLabel}. Length: ${lengthLabel}.`,
    ...(isHtml ? [HTML_STYLING_INSTRUCTIONS] : [])
  ].join(' ');
  return [
    { role: 'system', content: system },
    { role: 'user', content: String(prompt || '').trim() }
  ];
}

function parseDraftResponse(rawContent, type) {
  if (!rawContent || !rawContent.trim()) {
    throw new Error('The AI returned an empty response - try again.');
  }
  // Models sometimes wrap JSON in ```json fences despite instructions not to - strip defensively.
  const cleaned = rawContent.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error('Could not read the AI response as a template draft - try regenerating.');
  }
  if (!parsed || !parsed.subject || !parsed.body) {
    throw new Error('The AI response was missing a subject or body - try regenerating.');
  }

  const isHtml = type === 'html';
  return {
    name: (parsed.name || 'AI-generated template').toString().slice(0, 120),
    subject: parsed.subject.toString(),
    body_html: isHtml ? parsed.body.toString() : '',
    body_text: isHtml ? '' : parsed.body.toString(),
    type: isHtml ? 'html' : 'text'
  };
}

module.exports = { DEFAULT_MODEL, buildMessages, parseDraftResponse };
