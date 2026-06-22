const express = require('express');
const { google } = require('googleapis');
const Sentiment = require('sentiment');
const cors = require('cors');

const app = express();
const PORT = 5000;
const sentiment = new Sentiment();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

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
    /(?:youtube\.com\/embed\/)([\w-]+)/
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

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
