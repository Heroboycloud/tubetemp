const path= require("path");
const express = require('express');
const { google } = require('googleapis');
const Sentiment = require('sentiment');
const cors = require('cors');
const dotenv=require("dotenv");
dotenv.config();
const app = express();
const PORT = 5000;
const sentiment = new Sentiment();

// Middleware
app.use(cors());
app.use(express.json());

// YouTube API setup
const youtube = google.youtube({
  version: 'v3',
  auth: process.env.YOUTUBE_API_KEY
});

// Extract video ID from URL
function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([\w-]+)/,
    /(?:youtu\.be\/)([\w-]+)/,
    /(?:youtube\.com\/embed\/)([\w-]+)/,
    /(?:youtube\.com\/shorts\/)([\w-]+)/
  ];
  
  for (let pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// Fetch comments from YouTube
async function fetchVideoComments(videoId) {
  try {
    let allComments = [];
    let pageToken = null;
    
    do {
      const response = await youtube.commentThreads.list({
        part: ['snippet'],
        videoId: videoId,
        maxResults: 100,
        pageToken: pageToken,
        order: 'relevance'
      });
      
      const comments = response.data.items.map(item => ({
        author: item.snippet.topLevelComment.snippet.authorDisplayName,
        text: item.snippet.topLevelComment.snippet.textDisplay,
        likes: item.snippet.topLevelComment.snippet.likeCount,
        publishedAt: item.snippet.topLevelComment.snippet.publishedAt
      }));
      
      allComments = allComments.concat(comments);
      pageToken = response.data.nextPageToken;
      
    } while (pageToken && allComments.length < 500);
    
    return allComments;
  } catch (error) {
    console.error('YouTube API Error:', error.message);
    throw new Error('Failed to fetch comments. Make sure the video ID is valid.');
  }
}

// Analyze sentiment of comments
function analyzeSentiment(comments) {
  const results = comments.map(comment => {
    const analysis = sentiment.analyze(comment.text);
    return {
      ...comment,
      sentimentScore: analysis.score,
      sentiment: analysis.score > 0 ? 'positive' : 
                 analysis.score < 0 ? 'negative' : 'neutral',
      comparative: analysis.comparative,
      positiveWords: analysis.positive,
      negativeWords: analysis.negative
    };
  });
  
  // Overall statistics
  const positive = results.filter(c => c.sentiment === 'positive');
  const negative = results.filter(c => c.sentiment === 'negative');
  const neutral = results.filter(c => c.sentiment === 'neutral');
  
  const avgScore = results.reduce((sum, c) => sum + c.sentimentScore, 0) / results.length;
  
  // Determine overall mood
  let overallMood = 'neutral';
  let moodEmoji = '😐';
  let moodColor = '#ffc107';
  
  if (avgScore > 1) {
    overallMood = 'overwhelmingly positive';
    moodEmoji = '😍';
    moodColor = '#28a745';
  } else if (avgScore > 0.3) {
    overallMood = 'positive';
    moodEmoji = '😊';
    moodColor = '#28a745';
  } else if (avgScore < -1) {
    overallMood = 'overwhelmingly negative';
    moodEmoji = '😡';
    moodColor = '#dc3545';
  } else if (avgScore < -0.3) {
    overallMood = 'negative';
    moodEmoji = '😟';
    moodColor = '#dc3545';
  }
  
  return {
    totalComments: results.length,
    positiveCount: positive.length,
    negativeCount: negative.length,
    neutralCount: neutral.length,
    averageScore: avgScore,
    overallMood,
    moodEmoji,
    moodColor,
    comments: results.slice(0, 20), // Return top 20 for display
    positivePercentage: ((positive.length / results.length) * 100).toFixed(1),
    negativePercentage: ((negative.length / results.length) * 100).toFixed(1),
    neutralPercentage: ((neutral.length / results.length) * 100).toFixed(1)
  };
}

// API Endpoint: Get comment analysis
app.post('/api/analyze', async (req, res) => {
  try {
    const { videoUrl } = req.body;
    
    if (!videoUrl) {
      return res.status(400).json({ error: 'Video URL is required' });
    }
    
    const videoId = extractVideoId(videoUrl);
    if (!videoId) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }
    
    // Fetch comments
    const comments = await fetchVideoComments(videoId);
    
    if (comments.length === 0) {
      return res.status(404).json({ error: 'No comments found for this video' });
    }
    
    // Analyze sentiment
    const analysis = analyzeSentiment(comments);
    
    res.json({
      success: true,
      videoId,
      analysis,
      topComments: analysis.comments
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// --- Google sign-in (name + email only) ---
// Users are persisted in Supabase. Requires SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY to be set as environment variables.
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

app.post('/api/auth/google', async (req, res) => {
  const { name, email } = req.body || {};

  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  try {
    // Look for an existing user
    const { data: existing, error: findError } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    if (findError) throw findError;

    if (existing) {
      return res.json({ success: true, user: existing });
    }

    // Create a new user
    const { data: created, error: insertError } = await supabase
      .from('users')
      .insert({ name, email })
      .select()
      .single();

    if (insertError) throw insertError;

    res.json({ success: true, user: created });
  } catch (err) {
    console.error('Supabase auth error:', err.message);
    res.status(500).json({ error: 'Failed to save user' });
  }
});

// --- History (Supabase) ---
// Expected table "history":
//   id           text primary key   (client-generated, e.g. Date.now().toString(36) + random)
//   user_email   text not null
//   video_id     text
//   url          text
//   title        text
//   mood         text
//   analysis     jsonb              (full cached analysis payload, so past results reopen instantly)
//   created_at   timestamptz default now()
// If your table uses different column names, adjust the mappings below to match.

// Save/update a single history entry — called automatically after each analysis
app.post('/api/history', async (req, res) => {
  const { id, url, videoId, title, mood, timestamp, data, userEmail } = req.body || {};

  if (!userEmail) {
    return res.status(400).json({ error: 'userEmail is required' });
  }
  if (!id) {
    return res.status(400).json({ error: 'id is required' });
  }

  try {
    const { data: saved, error } = await supabase
      .from('history')
      .upsert({
        id,
        user_email: userEmail,
        video_id: videoId,
        url,
        title,
        mood,
        analysis: data,
        created_at: timestamp ? new Date(timestamp).toISOString() : new Date().toISOString()
      }, { onConflict: 'id' })
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, item: saved });
  } catch (err) {
    console.error('History save error:', err.message);
    res.status(500).json({ error: 'Failed to save history item' });
  }
});

// Batch sync — sends the full local (localStorage) history at once
app.post('/api/history/sync', async (req, res) => {
  const { items, userEmail } = req.body || {};

  if (!userEmail) {
    return res.status(400).json({ error: 'userEmail is required' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'No items to sync' });
  }

  try {
    const rows = items.map(item => ({
      id: item.id,
      user_email: userEmail,
      video_id: item.videoId,
      url: item.url,
      title: item.title,
      mood: item.mood,
      analysis: item.data,
      created_at: item.timestamp ? new Date(item.timestamp).toISOString() : new Date().toISOString()
    }));

    const { error } = await supabase
      .from('history')
      .upsert(rows, { onConflict: 'id' });

    if (error) throw error;

    res.json({ success: true, synced: rows.length });
  } catch (err) {
    console.error('History sync error:', err.message);
    res.status(500).json({ error: 'Sync failed' });
  }
});

// Fetch a user's saved history — e.g. to restore on a new device/browser
app.get('/api/history/:email', async (req, res) => {
  const { email } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);

  try {
    const { data, error } = await supabase
      .from('history')
      .select('*')
      .eq('user_email', email)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    res.json({ success: true, items: data });
  } catch (err) {
    console.error('History fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// Delete a single history item
app.delete('/api/history/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const { error } = await supabase.from('history').delete().eq('id', id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('History delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete history item' });
  }
});

// Clear all history for a user
app.delete('/api/history', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email query param is required' });

  try {
    const { error } = await supabase.from('history').delete().eq('user_email', email);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('History clear error:', err.message);
    res.status(500).json({ error: 'Failed to clear history' });
  }
});

// --- User profile & usage (Supabase) ---
// Reuses the existing "users" table from /api/auth/google.
// If you add a "plan" column (text, default 'free'), the routes below
// are already set up to read/update it.

// Fetch a user's profile
app.get('/api/user/:email', async (req, res) => {
  const { email } = req.params;

  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'User not found' });

    res.json({ success: true, user: data });
  } catch (err) {
    console.error('User fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// Update a user's profile (e.g. name, plan)
app.patch('/api/user/:email', async (req, res) => {
  const { email } = req.params;
  const { name, plan } = req.body || {};
  const updates = {};
  if (name) updates.name = name;
  if (plan) updates.plan = plan;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'Nothing to update' });
  }

  try {
    const { data, error } = await supabase
      .from('users')
      .update(updates)
      .eq('email', email)
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, user: data });
  } catch (err) {
    console.error('User update error:', err.message);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Usage stats for a user — handy for enforcing the Free plan's
// "5 analyses per day" limit, or showing a usage widget in the dashboard
app.get('/api/usage/:email', async (req, res) => {
  const { email } = req.params;
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  try {
    const { count, error } = await supabase
      .from('history')
      .select('id', { count: 'exact', head: true })
      .eq('user_email', email)
      .gte('created_at', startOfDay.toISOString());

    if (error) throw error;

    res.json({ success: true, analysesToday: count || 0, resetsAt: new Date(startOfDay.getTime() + 86400000).toISOString() });
  } catch (err) {
    console.error('Usage fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch usage' });
  }
});

// Login / landing page — first thing a visitor sees
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

// Dashboard — the analyzer tool (previously served at "/")
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Pricing page
app.get('/pricing', (req, res) => {
  res.sendFile(path.join(__dirname, 'pricing.html'));
});


module.exports = app;

/*
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
*/
