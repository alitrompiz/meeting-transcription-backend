// Meeting Transcription API - Vercel Serverless Function
// Handles audio transcription with OpenAI Whisper and GPT-4o

import OpenAI from 'openai';

export const config = {
  maxDuration: 300, // 5 minutes max execution time
};

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { 
      audioUrl, 
      meetingName, 
      participants,
      openaiApiKey 
    } = req.body;

    // Validate required fields
    if (!audioUrl) {
      return res.status(400).json({ error: 'audioUrl is required' });
    }

    if (!openaiApiKey) {
      return res.status(400).json({ error: 'openaiApiKey is required' });
    }

    // Initialize OpenAI client
    const openai = new OpenAI({ apiKey: openaiApiKey });

    console.log('Starting transcription for:', meetingName);
    console.log('Audio URL:', audioUrl);

    // Step 1: Download audio file
    // Auto-append directDownload=true for Zoho WorkDrive URLs
    let downloadUrl = audioUrl;
    if (audioUrl.includes('workdrive.zoho')) {
      if (audioUrl.includes('?')) {
        downloadUrl = audioUrl + '&directDownload=true';
      } else {
        downloadUrl = audioUrl + '?directDownload=true';
      }
      console.log('Modified WorkDrive URL for direct download:', downloadUrl);
    }

    const audioResponse = await fetch(downloadUrl);
    if (!audioResponse.ok) {
      throw new Error(`Failed to download audio file: ${audioResponse.status} ${audioResponse.statusText}`);
    }
    
    const audioBuffer = await audioResponse.arrayBuffer();
    
    // Detect file type from URL or default to m4a (common for iPhone Voice Memos)
    let mimeType = 'audio/mp4';
    let fileName = 'audio.m4a';
    
    if (audioUrl.toLowerCase().includes('.mp3')) {
      mimeType = 'audio/mpeg';
      fileName = 'audio.mp3';
    } else if (audioUrl.toLowerCase().includes('.wav')) {
      mimeType = 'audio/wav';
      fileName = 'audio.wav';
    } else if (audioUrl.toLowerCase().includes('.m4a')) {
      mimeType = 'audio/mp4';
      fileName = 'audio.m4a';
    } else if (audioUrl.toLowerCase().includes('.mp4')) {
      mimeType = 'audio/mp4';
      fileName = 'audio.mp4';
    } else if (audioUrl.toLowerCase().includes('.ogg')) {
      mimeType = 'audio/ogg';
      fileName = 'audio.ogg';
    } else if (audioUrl.toLowerCase().includes('.webm')) {
      mimeType = 'audio/webm';
      fileName = 'audio.webm';
    }
    
    const audioBlob = new Blob([audioBuffer], { type: mimeType });
    const audioFile = new File([audioBlob], fileName, { type: mimeType });

    console.log('Audio file downloaded, size:', audioBuffer.byteLength, 'type:', mimeType);

    // Step 2: Transcribe with Whisper
    console.log('Sending to OpenAI Whisper...');
    
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    });

    console.log('Transcription complete, segments:', transcription.segments?.length || 0);

    // Step 3: Match speakers using GPT-4o (if participants provided)
    let matchedTranscript = transcription.text;
    let speakerSummaries = [];
    let meetingSummary = '';

    if (participants && participants.length > 0) {
      console.log('Matching speakers with GPT-4o...');

      const participantList = participants
        .map((p, i) => `${i + 1}. "${p.speaker}" - Sample quote: "${p.sampleQuote || 'Not provided'}"`)
        .join('\n');

      const matchingPrompt = `You are analyzing a meeting transcript to identify speakers.

PARTICIPANTS IN THIS MEETING:
${participantList}

TRANSCRIPT:
${transcription.text}

INSTRUCTIONS:
1. Analyze the transcript and identify which parts were likely spoken by each participant
2. Use the sample quotes (if provided) to help match speaking styles
3. Rewrite the transcript with speaker labels

OUTPUT FORMAT:
Return a JSON object with:
{
  "transcript": "The full transcript with speaker labels like 'Speaker Name: text...'",
  "speakers": [
    {
      "name": "Speaker Name",
      "wordCount": 123,
      "summary": "Brief 2-3 sentence summary of what they said"
    }
  ],
  "meetingSummary": "Overall 3-4 sentence summary of the meeting"
}`;

      const gptResponse = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are an expert at analyzing meeting transcripts and identifying speakers. Always respond with valid JSON.' },
          { role: 'user', content: matchingPrompt }
        ],
        response_format: { type: 'json_object' },
        max_tokens: 4000,
      });

      try {
        const analysis = JSON.parse(gptResponse.choices[0].message.content);
        matchedTranscript = analysis.transcript || transcription.text;
        speakerSummaries = analysis.speakers || [];
        meetingSummary = analysis.meetingSummary || '';
      } catch (parseError) {
        console.error('Failed to parse GPT response:', parseError);
        matchedTranscript = transcription.text;
      }
    } else {
      // No participants provided - just summarize
      console.log('No participants provided, generating summary only...');
      
      const summaryResponse = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'Summarize this meeting transcript in 3-4 sentences.' },
          { role: 'user', content: transcription.text }
        ],
        max_tokens: 500,
      });
      
      meetingSummary = summaryResponse.choices[0].message.content;
    }

    // Return results
    const result = {
      success: true,
      meetingName: meetingName || 'Untitled Meeting',
      transcript: matchedTranscript,
      rawTranscript: transcription.text,
      segments: transcription.segments || [],
      speakers: speakerSummaries,
      meetingSummary: meetingSummary,
      duration: transcription.duration || 0,
      language: transcription.language || 'en',
    };

    console.log('Processing complete!');
    return res.status(200).json(result);

  } catch (error) {
    console.error('Transcription error:', error);
    return res.status(500).json({ 
      error: 'Transcription failed', 
      message: error.message 
    });
  }
}
