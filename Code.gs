// ============================================================================
// Igbo Origins — Session Notes Automation
// ============================================================================
// Automates steps 2–7 of the Session Notes Guidance document.
// Meet transcript → Gemini API → Draft Google Doc → cross-post → notify.
//
// Human-in-the-loop is preserved: the doc is created as DRAFT.
// Nothing is published without the note-taker's review pass.
// ============================================================================

// ---------------------------------------------------------------------------
// 1. CONFIGURATION — Edit these values before first run
// ---------------------------------------------------------------------------

function getConfig() {
  return {
    // Gemini API key — store in Script Properties for security (see README)
    GEMINI_API_KEY: PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY'),

    // Gemini model to use
    GEMINI_MODEL: 'gemini-2.0-flash',

    // Google Drive folder IDs (get from the URL: drive.google.com/drive/folders/<THIS_ID>)
    TRANSCRIPT_FOLDER_ID: PropertiesService.getScriptProperties().getProperty('TRANSCRIPT_FOLDER_ID'),       // Where Meet transcripts land
    SESSION_NOTES_FOLDER_ID: PropertiesService.getScriptProperties().getProperty('SESSION_NOTES_FOLDER_ID'), // Weekly_Session_Notes folder
    RISK_LOG_SHEET_ID: PropertiesService.getScriptProperties().getProperty('RISK_LOG_SHEET_ID'),             // Risk & Assumption Log Google Sheet ID

    // Risk Log sheet tab name
    RISK_LOG_TAB_NAME: 'Risks',

    // Notification recipients (comma-separated emails)
    NOTETAKER_EMAILS: PropertiesService.getScriptProperties().getProperty('NOTETAKER_EMAILS') || '',

    // Google Chat webhook URL (create in Chat space > Apps & integrations > Webhooks)
    CHAT_WEBHOOK_URL: PropertiesService.getScriptProperties().getProperty('CHAT_WEBHOOK_URL') || '',

    // Project start date and first session number (for auto-numbering)
    FIRST_SESSION_DATE: '2026-05-05',
    FIRST_SESSION_NUMBER: 1,
  };
}


// ---------------------------------------------------------------------------
// 2. GEM SYSTEM PROMPT — Replicated from IO Session Notes v3.0
// ---------------------------------------------------------------------------

const GEM_SYSTEM_PROMPT = `You are a single-purpose assistant. Your only job is to draft weekly session notes from a meeting transcript for the Igbo Origins project, a discovery effort by Chiemeka Ozumba and Eche Ifediora.

Scope and Refusal:
- Refuse any request that is not "produce session notes from this transcript."
- If a request is out of scope, respond with exactly: "I only produce session notes from meeting transcripts for the Igbo Origins project. Please paste a transcript and I'll draft the notes. For anything else, use a general-purpose assistant."

Output Format and Content Rules:
- The first line of every output must be the document title in this exact format: "Session Notes [number] – [YYYY-MM-DD]". Use two-digit session numbers (01, 02, 03). Use ISO date format.
- Use bullets only. No prose paragraphs, no executive summaries.
- Do not invent or infer details. If unsure about a decision, action, owner, or date, place it under "Flagged for human review" rather than guessing.
- Use UK English. No em dashes, no emojis. Use markdown heading syntax: "#" for the document title (Heading 1), "##" for section headings (Heading 2). No bold or italics elsewhere in the output.
- If a section has no entries, write "None this session".
- Decisions: Must be specific and complete (e.g., "Agreed to use Notion as documentation hub").
- Actions: Must have an owner (Chiemeka, Eche, or Both) and a date (default: "(by next Sunday)").
- Risks and Assumptions: Only items newly raised in the session.
- Parked / Unresolved: Items deliberately deferred.
- Notes worth remembering: Optional, used sparingly for non-decision items that should not be lost.
- Flagged for human review: For ambiguous wording or missing details.

Structure:
# Session Notes [number] – [YYYY-MM-DD]
Present: [names]
Transcript: [link to be inserted by human]

## Decisions made
- [Entry]

## Actions this week
- [Owner]: [Action] (by [date])

## Risks and assumptions raised
- [Entry]

## Parked / unresolved
- [Entry]

## Notes worth remembering
- [Entry]

## Flagged for human review
- [Entry]

Tone: Neutral, factual, and telegraphic. Avoid personal context, small talk, and your own interpretation.
Stay strictly within these instructions. If uncertain whether a request is in scope, treat it as out of scope and refuse.`;


// ---------------------------------------------------------------------------
// 3. MAIN ORCHESTRATOR
// ---------------------------------------------------------------------------

/**
 * Main entry point — run manually or via time-based trigger.
 * Finds unprocessed transcripts and runs the full pipeline on each.
 */
function processNewTranscripts() {
  const config = getConfig();
  validateConfig_(config);

  const transcripts = findUnprocessedTranscripts_(config);

  if (transcripts.length === 0) {
    Logger.log('No new transcripts found.');
    return;
  }

  Logger.log(`Found ${transcripts.length} new transcript(s) to process.`);

  transcripts.forEach(transcript => {
    try {
      Logger.log(`Processing: ${transcript.getName()}`);

      const transcriptText = extractTranscriptText_(transcript);
      const sessionInfo = determineSessionInfo_(config, transcript);
      const draftMarkdown = callGeminiAPI_(config, transcriptText, sessionInfo);
      const draftDoc = createDraftDoc_(config, draftMarkdown, sessionInfo);

      const risks = extractSection_(draftMarkdown, 'Risks and assumptions raised');
      if (risks.length > 0) {
        crossPostRisks_(config, risks, sessionInfo);
      }

      notifyNoteTakers_(config, draftDoc, sessionInfo);
      markAsProcessed_(transcript);

      Logger.log(`Completed: Session ${sessionInfo.number}`);

    } catch (error) {
      Logger.log(`ERROR processing ${transcript.getName()}: ${error.message}`);
      notifyError_(config, transcript.getName(), error.message);
    }
  });
}


/**
 * Manual trigger — process a specific transcript by file ID.
 * Useful for re-running or testing with a known transcript.
 */
function processSpecificTranscript(fileId) {
  const config = getConfig();
  validateConfig_(config);

  try {
    const transcript = DriveApp.getFileById(fileId);
    const transcriptText = extractTranscriptText_(transcript);
    const sessionInfo = determineSessionInfo_(config, transcript);
    const draftMarkdown = callGeminiAPI_(config, transcriptText, sessionInfo);
    const draftDoc = createDraftDoc_(config, draftMarkdown, sessionInfo);

    const risks = extractSection_(draftMarkdown, 'Risks and assumptions raised');
    if (risks.length > 0) crossPostRisks_(config, risks, sessionInfo);

    notifyNoteTakers_(config, draftDoc, sessionInfo);
    markAsProcessed_(transcript);

    Logger.log(`Done. Draft created: ${draftDoc.getUrl()}`);
    return draftDoc.getUrl();

  } catch (error) {
    Logger.log(`ERROR processing file ${fileId}: ${error.message}`);
    notifyError_(config, fileId, error.message);
    throw error;
  }
}


// ---------------------------------------------------------------------------
// 4. TRANSCRIPT DISCOVERY
// ---------------------------------------------------------------------------

/**
 * Finds transcripts in the configured folder that haven't been processed yet.
 * Uses a script property 'processed_<fileId>' on each file to track state.
 */
function findUnprocessedTranscripts_(config) {
  Logger.log(`config.TRANSCRIPT_FOLDER_ID: ${config.TRANSCRIPT_FOLDER_ID}`);
  const folder = DriveApp.getFolderById(config.TRANSCRIPT_FOLDER_ID);
  const files = folder.getFiles();
  const unprocessed = [];

  while (files.hasNext()) {
    const file = files.next();
    const name = file.getName().toLowerCase();

    if (name.includes('transcript') && file.getMimeType() === 'application/vnd.google-apps.document') {
      const props = PropertiesService.getScriptProperties();
      const processedKey = `processed_${file.getId()}`;
      if (!props.getProperty(processedKey)) {
        unprocessed.push(file);
      }
    }
  }

  unprocessed.sort((a, b) => a.getDateCreated().getTime() - b.getDateCreated().getTime());
  return unprocessed;
}


/**
 * Extracts plain text from a Google Docs transcript file.
 */
function extractTranscriptText_(file) {
  const doc = DocumentApp.openById(file.getId());
  const text = doc.getBody().getText();

  if (!text || text.trim().length < 100) {
    throw new Error(`Transcript appears empty or too short (${text.length} chars). Skipping.`);
  }

  return text;
}


// ---------------------------------------------------------------------------
// 5. SESSION INFO (number + date)
// ---------------------------------------------------------------------------

/**
 * Determines the session number and date from context.
 * Session 01 = FIRST_SESSION_DATE. Each Sunday after that increments by 1.
 *
 * Both dates are normalised to Europe/London midnight via Utilities.formatDate
 * to avoid UTC-vs-local skew when computing the week difference.
 */
function determineSessionInfo_(config, transcript) {
  const transcriptDate = transcript.getDateCreated();
  const sessionDate = findNearestSunday_(transcriptDate);

  // Format in London time to avoid UTC-vs-BST skew
  const dateStr = Utilities.formatDate(sessionDate, 'Europe/London', 'yyyy-MM-dd');

  // Normalise firstDate to London midnight by parsing via the same formatter
  const firstDateRaw = new Date(config.FIRST_SESSION_DATE + 'T12:00:00Z'); // noon UTC avoids any DST edge
  const firstDateStr = Utilities.formatDate(firstDateRaw, 'Europe/London', 'yyyy-MM-dd');
  const firstDateNormalised = new Date(firstDateStr + 'T00:00:00');

  const sessionDateNormalised = new Date(dateStr + 'T00:00:00');
  const weeksDiff = Math.round(
    (sessionDateNormalised.getTime() - firstDateNormalised.getTime()) / (7 * 24 * 60 * 60 * 1000)
  );
  const sessionNumber = config.FIRST_SESSION_NUMBER + Math.max(0, weeksDiff);
  const paddedNumber = String(sessionNumber).padStart(2, '0');

  return {
    number: paddedNumber,
    date: dateStr,
    filename: `${dateStr}_Session_Notes_${paddedNumber}`,
    title: `Session Notes ${paddedNumber} – ${dateStr}`,
  };
}


/**
 * Returns the most recent Sunday on or before the given date.
 * A transcript uploaded on Saturday night will map to the previous Sunday,
 * meaning it's tagged to that week's session — this is intentional.
 */
function findNearestSunday_(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0 = Sunday
  const diff = day === 0 ? 0 : day;
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
}


// ---------------------------------------------------------------------------
// 6. GEMINI API CALL
// ---------------------------------------------------------------------------

/**
 * Calls the Gemini API with the transcript and system prompt.
 * Returns the raw markdown output.
 *
 * Common causes of 403 PERMISSION_DENIED:
 *   1. "Generative Language API" not enabled in Cloud Console > APIs & Services.
 *   2. API key has HTTP-referrer or IP restrictions that block Apps Script servers.
 *   3. Billing not enabled on the Cloud project.
 *   4. Workspace org policy blocking Generative AI APIs.
 */
function callGeminiAPI_(config, transcriptText, sessionInfo) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.GEMINI_MODEL}:generateContent?key=${config.GEMINI_API_KEY}`;

  const payload = {
    system_instruction: {
      parts: [{ text: GEM_SYSTEM_PROMPT }]
    },
    contents: [
      {
        role: 'user',
        parts: [{
          text: `This is the transcript for Session ${sessionInfo.number}, dated ${sessionInfo.date}. Please produce the session notes.\n\n---\n\n${transcriptText}`
        }]
      }
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 4096,
    }
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  const response = UrlFetchApp.fetch(url, options);
  const statusCode = response.getResponseCode();

  if (statusCode === 403) {
    const body = response.getContentText();
    const isPermissionDenied = body.includes('PERMISSION_DENIED') || body.includes('denied access');
    if (isPermissionDenied) {
      throw new Error(
        'Gemini API returned 403 PERMISSION_DENIED. ' +
        'To fix: (1) enable the "Generative Language API" in Cloud Console > APIs & Services; ' +
        '(2) remove any HTTP-referrer/IP restrictions from the API key; ' +
        '(3) confirm billing is enabled on the Cloud project. ' +
        'Raw response: ' + body.substring(0, 300)
      );
    }
    throw new Error(`Gemini API returned 403: ${body.substring(0, 500)}`);
  }

  if (statusCode !== 200) {
    throw new Error(`Gemini API returned ${statusCode}: ${response.getContentText().substring(0, 500)}`);
  }

  const result = JSON.parse(response.getContentText());
  const output = result.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!output) {
    throw new Error('Gemini API returned empty output. Check the transcript content.');
  }

  return output;
}


// ---------------------------------------------------------------------------
// 7. DRAFT DOCUMENT CREATION
// ---------------------------------------------------------------------------

/**
 * Creates a Google Doc in the session notes folder with the draft content.
 * Converts markdown headings to proper Doc headings.
 * Returns the created file (DriveApp.File).
 */
function createDraftDoc_(config, markdown, sessionInfo) {
  const folder = DriveApp.getFolderById(config.SESSION_NOTES_FOLDER_ID);

  const existing = folder.getFilesByName(sessionInfo.filename);
  if (existing.hasNext()) {
    Logger.log(`WARNING: A file named "${sessionInfo.filename}" already exists. Appending _DRAFT.`);
    sessionInfo.filename += '_DRAFT';
  }

  const doc = DocumentApp.create(sessionInfo.filename);
  const body = doc.getBody();

  const banner = body.insertParagraph(0, '⚠ DRAFT — Awaiting human review. Do not treat as final.');
  banner.setAttributes({
    [DocumentApp.Attribute.FONT_SIZE]: 11,
    [DocumentApp.Attribute.FOREGROUND_COLOR]: '#D93025',
    [DocumentApp.Attribute.BOLD]: true,
  });
  body.appendHorizontalRule();

  const lines = markdown.split('\n');
  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed) return;

    if (trimmed.startsWith('# ')) {
      const para = body.appendParagraph(trimmed.substring(2));
      para.setHeading(DocumentApp.ParagraphHeading.HEADING1);
    } else if (trimmed.startsWith('## ')) {
      const para = body.appendParagraph(trimmed.substring(3));
      para.setHeading(DocumentApp.ParagraphHeading.HEADING2);
    } else if (trimmed.startsWith('- ')) {
      const para = body.appendListItem(trimmed.substring(2));
      para.setGlyphType(DocumentApp.GlyphType.BULLET);
    } else {
      body.appendParagraph(trimmed);
    }
  });

  const file = DriveApp.getFileById(doc.getId());
  folder.addFile(file);
  DriveApp.getRootFolder().removeFile(file);

  doc.saveAndClose();
  return file;
}


// ---------------------------------------------------------------------------
// 8. CROSS-POSTING: RISKS → RISK & ASSUMPTION LOG (Google Sheet)
// ---------------------------------------------------------------------------

/**
 * Appends risks to the Risk & Assumption Log Google Sheet.
 * Each risk gets a row: Session, Date, Risk Description, Status, Source.
 *
 * NOTE: The Risk Log must be a Google Sheet (not .xlsx). Convert via
 * File > Save as Google Sheets in Drive if needed.
 */
function crossPostRisks_(config, risks, sessionInfo) {
  if (!config.RISK_LOG_SHEET_ID) {
    Logger.log('Risk Log Sheet ID not configured. Skipping cross-post.');
    return;
  }

  try {
    const sheet = SpreadsheetApp.openById(config.RISK_LOG_SHEET_ID)
      .getSheetByName(config.RISK_LOG_TAB_NAME);

    if (!sheet) {
      throw new Error(`Tab "${config.RISK_LOG_TAB_NAME}" not found in the Risk Log spreadsheet.`);
    }

    risks.forEach(risk => {
      sheet.appendRow([
        sessionInfo.number,
        sessionInfo.date,
        risk,
        'Open',
        'Auto-posted by script',
      ]);
    });

    Logger.log(`Cross-posted ${risks.length} risk(s) to Risk & Assumption Log.`);
  } catch (error) {
    Logger.log(`WARNING: Failed to cross-post risks: ${error.message}`);
  }
}


// ---------------------------------------------------------------------------
// 9. NOTIFICATIONS
// ---------------------------------------------------------------------------

/**
 * Sends email and Google Chat notifications to the note-taker(s).
 */
function notifyNoteTakers_(config, draftDoc, sessionInfo) {
  const docUrl = draftDoc.getUrl();
  const subject = `[Igbo Origins] Draft ready: ${sessionInfo.title}`;

  const emailBody = [
    `A draft of ${sessionInfo.title} has been generated and is ready for your review.`,
    '',
    `Open the draft: ${docUrl}`,
    '',
    'Review checklist:',
    '  - Confirm session number is correct',
    '  - Check decisions are stated correctly',
    '  - Check actions have clear owners and dates',
    '  - Verify cross-posted risks in the Risk Log',
    '  - Remove the DRAFT banner when satisfied',
    '',
    'This draft was auto-generated from the Meet transcript. Treat it as a draft, never as ground truth.',
  ].join('\n');

  if (config.NOTETAKER_EMAILS) {
    const recipients = config.NOTETAKER_EMAILS.split(',').map(e => e.trim()).filter(Boolean);
    recipients.forEach(email => {
      try {
        MailApp.sendEmail({ to: email, subject: subject, body: emailBody });
        Logger.log(`Email sent to ${email}`);
      } catch (error) {
        Logger.log(`WARNING: Failed to email ${email}: ${error.message}`);
      }
    });
  }

  if (config.CHAT_WEBHOOK_URL) {
    try {
      const chatPayload = {
        text: `*${sessionInfo.title}* draft is ready for review.\n${docUrl}`,
      };
      UrlFetchApp.fetch(config.CHAT_WEBHOOK_URL, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(chatPayload),
      });
      Logger.log('Google Chat notification sent.');
    } catch (error) {
      Logger.log(`WARNING: Failed to send Chat notification: ${error.message}`);
    }
  }
}


/**
 * Sends an error notification so failures don't go unnoticed.
 */
function notifyError_(config, transcriptName, errorMessage) {
  if (config.NOTETAKER_EMAILS) {
    const recipients = config.NOTETAKER_EMAILS.split(',').map(e => e.trim()).filter(Boolean);
    recipients.forEach(email => {
      try {
        MailApp.sendEmail({
          to: email,
          subject: `[Igbo Origins] Session Notes automation error`,
          body: `The automation failed to process transcript: ${transcriptName}\n\nError: ${errorMessage}\n\nPlease process this transcript manually using the Gem.`,
        });
      } catch (e) {
        Logger.log(`Could not send error email: ${e.message}`);
      }
    });
  }
}


// ---------------------------------------------------------------------------
// 10. SECTION PARSING
// ---------------------------------------------------------------------------

/**
 * Extracts bullet items from a named section of the markdown output.
 * Returns an array of strings (without the leading "- ").
 * Filters out "None this session".
 */
function extractSection_(markdown, sectionName) {
  const lines = markdown.split('\n');
  let inSection = false;
  const items = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.toLowerCase() === `## ${sectionName.toLowerCase()}`) {
      inSection = true;
      continue;
    }

    if (inSection && trimmed.startsWith('## ')) {
      break;
    }

    if (inSection && trimmed.startsWith('- ')) {
      const item = trimmed.substring(2).trim();
      if (item.toLowerCase() !== 'none this session') {
        items.push(item);
      }
    }
  }

  return items;
}


// ---------------------------------------------------------------------------
// 11. PROCESSING STATE
// ---------------------------------------------------------------------------

/**
 * Marks a transcript file as processed so it won't be picked up again.
 */
function markAsProcessed_(file) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty(`processed_${file.getId()}`, new Date().toISOString());
}


/**
 * Resets a transcript's processed state (useful for re-running).
 */
function resetProcessedState(fileId) {
  PropertiesService.getScriptProperties().deleteProperty(`processed_${fileId}`);
  Logger.log(`Reset processed state for file: ${fileId}`);
}


/**
 * Lists all processed transcript IDs (for debugging).
 */
function listProcessedTranscripts() {
  const props = PropertiesService.getScriptProperties().getProperties();
  const processed = Object.entries(props)
    .filter(([key]) => key.startsWith('processed_'))
    .map(([key, value]) => ({ fileId: key.replace('processed_', ''), processedAt: value }));

  Logger.log(`Processed transcripts: ${JSON.stringify(processed, null, 2)}`);
  return processed;
}


// ---------------------------------------------------------------------------
// 12. VALIDATION AND SETUP HELPERS
// ---------------------------------------------------------------------------

/**
 * Validates that required configuration is present.
 */
function validateConfig_(config) {
  const required = ['GEMINI_API_KEY', 'TRANSCRIPT_FOLDER_ID', 'SESSION_NOTES_FOLDER_ID'];
  const missing = required.filter(key => !config[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required configuration: ${missing.join(', ')}. See README for setup instructions.`);
  }
}


/**
 * Run this once to initialise Script Properties with placeholder values.
 * After running, go to Project Settings > Script Properties to fill in real values.
 */
function setupProperties() {
  const props = PropertiesService.getScriptProperties();

  const defaults = {
    'GEMINI_API_KEY': 'YOUR_GEMINI_API_KEY_HERE',
    'TRANSCRIPT_FOLDER_ID': 'YOUR_TRANSCRIPT_FOLDER_ID_HERE',
    'SESSION_NOTES_FOLDER_ID': 'YOUR_SESSION_NOTES_FOLDER_ID_HERE',
    'RISK_LOG_SHEET_ID': '',
    'NOTETAKER_EMAILS': '',
    'CHAT_WEBHOOK_URL': '',
  };

  Object.entries(defaults).forEach(([key, defaultValue]) => {
    if (!props.getProperty(key)) {
      props.setProperty(key, defaultValue);
    }
  });

  Logger.log('Script Properties initialised. Go to Project Settings > Script Properties to fill in your values.');
}


/**
 * Sets up a weekly time-based trigger to run every Monday at 08:00 London time.
 * This gives 24 hours after the Sunday session for the transcript to be ready.
 */
function createWeeklyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'processNewTranscripts')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('processNewTranscripts')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(8)
    .nearMinute(0)
    .inTimezone('Europe/London')
    .create();

  Logger.log('Weekly trigger created: Mondays at 08:00 London time.');
}


/**
 * Removes all triggers for this script.
 */
function removeAllTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  Logger.log('All triggers removed.');
}
