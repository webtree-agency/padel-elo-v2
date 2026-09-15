// Modified server.js file with cron jobs functionality

const express = require('express');
const dotenv = require('dotenv');
const morgan = require('morgan');
const path = require('path');
const connectDB = require('./config/db');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const { generalLimiter } = require('./middleware/rateLimitMiddleware');
const { initCronJobs } = require('./utils/cronJobs');
const mongoose = require('mongoose');
const { migrateLegacyImages } = require('./utils/umkleideMedia');

// Load environment variables
dotenv.config();

// Connect to database
connectDB();

// Alte Base64-Bilder des Umkleide-Displays einmalig nach GridFS übernehmen
mongoose.connection.once('open', () => {
  migrateLegacyImages().catch((error) => console.error('Umkleide-Migration fehlgeschlagen:', error));
});

// Initialize app
const app = express();

// Apply global rate limiter
// app.use(generalLimiter);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://cdn.jsdelivr.net", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:"],
    },
  },
}));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(morgan('dev'));

// Set static folder
app.use(express.static(path.join(__dirname, 'public')));

// Set up session with MongoDB store
app.use(
  session({
    secret: process.env.JWT_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ 
      mongoUrl: process.env.MONGO_URI,
      collection: 'sessions'
    }),
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 7, // 1 week
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict'
    }
  })
);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Make moment-timezone available in all templates
const moment = require('moment-timezone');
app.locals.moment = moment;

// Initialize cron jobs for quarterly awards
initCronJobs(app);

app.use('/', require('./routes/publicRoutes'));
app.use('/auth', require('./routes/authRoutes'));
app.use('/user', require('./routes/userRoutes'));
app.use('/game', require('./routes/gameRoutes'));
app.use('/tournament', require('./routes/tournamentRoutes'));
app.use('/admin', require('./routes/adminRoutes'));

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  
  // Check if error is from rate-limiter
  if (err.statusCode === 429) {
    return res.status(429).render('error', {
      title: 'Zu viele Anfragen',
      message: err.message || 'Zu viele Anfragen. Bitte versuche es später erneut.'
    });
  }
  
  res.status(500).render('error', { 
    title: 'Server Error',
    message: process.env.NODE_ENV === 'production' 
      ? 'Etwas ist schiefgelaufen!' 
      : err.message
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).render('error', { 
    title: '404 Not Found', 
    message: 'Die gesuchte Seite existiert nicht.' 
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});