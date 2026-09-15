const mongoose = require('mongoose');
const User = require('../models/User');
const Game = require('../models/Game');
const RegistrationRequest = require('../models/RegistrationRequest');
const GameReport = require('../models/GameReport');
const QuarterlyELO = require('../models/QuarterlyELO');
const PadelSchedule = require('../models/PadelSchedule');
const UmkleideSetting = require('../models/UmkleideSetting');
const umkleideMedia = require('../utils/umkleideMedia');
const moment = require('moment-timezone');
const { sendRegistrationApprovedEmail, sendScheduleNotificationEmail } = require('../config/email');
const { recalculateQuarterlyELO, recalculateAllELO, distributeQuarterlyAwards } = require('../utils/cronJobs');
const { getShirtLevel, SHIRT_LEVELS } = require('../utils/shirtLevelUtils');
const { getAllAwardTypes, getAvailableQuarters, getAwardInfo } = require('../utils/awardUtils');


/**
 * Lädt die Anzahl der gespielten Spiele für eine Liste von Spielern
 * @param {Array} playerIds - Array von Spieler-IDs
 * @returns {Object} - Map von Spieler-ID zu Anzahl Spiele
 */
async function getPlayersGamesCount(playerIds) {
  const gamesCountMap = {};

  // Initialisiere alle mit 0
  playerIds.forEach(id => {
    gamesCountMap[id.toString()] = 0;
  });

  // Zähle Spiele für jeden Spieler einzeln (einfach und zuverlässig)
  for (const playerId of playerIds) {
    const count = await Game.countDocuments({
      $or: [
        { 'team1.player': playerId },
        { 'team2.player': playerId }
      ]
    });
    gamesCountMap[playerId.toString()] = count;
  }

  return gamesCountMap;
}

/**
 * Sortiert Spieler für den Spielplan:
 * - Normale Spieler: Nach ELO (höchste zuerst)
 * - Neue Spieler (0 Spiele): Werden ans Ende sortiert (in die schlechteste Gruppe)
 * @param {Array} players - Array von Spieler-Objekten mit _id und eloRating
 * @param {Object} gamesCountMap - Map von Spieler-ID zu Anzahl Spiele
 * @returns {Array} - Sortiertes Array von Spielern
 */
function sortPlayersForSchedule(players, gamesCountMap) {
  return [...players].sort((a, b) => {
    const aId = a._id.toString();
    const bId = b._id.toString();
    const aGames = gamesCountMap[aId] || 0;
    const bGames = gamesCountMap[bId] || 0;

    // Wenn beide neu sind (0 Spiele), sortiere nach ELO untereinander
    if (aGames === 0 && bGames === 0) {
      return b.eloRating - a.eloRating;
    }

    // Neue Spieler (0 Spiele) kommen ans Ende
    if (aGames === 0) return 1;
    if (bGames === 0) return -1;

    // Normale Sortierung nach ELO (höchste zuerst)
    return b.eloRating - a.eloRating;
  });
}

// @desc    Admin dashboard
// @route   GET /admin/dashboard
// @access  Private (Admin only)
exports.getDashboard = async (req, res) => {
  try {
    // Get counts
    const userCount = await User.countDocuments({ isAdmin: false });
    const gameCount = await Game.countDocuments();
    const pendingRequestsCount = await RegistrationRequest.countDocuments({ status: 'pending' });
    
    // Get Letzte Spiele - limit to 5
    const recentGames = await Game.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .populate('team1.player team2.player createdBy', 'username');
    
    // Get recently registered users - limit to 5
    const recentUsers = await User.find({ isAdmin: false })
      .sort({ createdAt: -1 })
      .limit(5);
    
    res.render('admin/dashboard', {
      title: 'Admin Dashboard',
      stats: {
        userCount,
        gameCount,
        pendingRequestsCount
      },
      recentGames,
      recentUsers,
      moment
    });
  } catch (error) {
    console.error('Admin dashboard error:', error);
    res.status(500).render('error', { 
      title: 'Server Error',
      message: 'An error occurred while loading the dashboard'
    });
  }
};

// @desc    Manage users
// @route   GET /admin/users
// @access  Private (Admin only)
exports.manageUsers = async (req, res) => {
  try {
    // Get query parameters
    const { search, page = 1, limit = 10, shirtLevel } = req.query;

    // Convert page and limit to numbers
    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 10;
    const skip = (pageNum - 1) * limitNum;

    // Build query
    let query = { isAdmin: false };

    if (search) {
      query = {
        ...query,
        $or: [
          { username: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } }
        ]
      };
    }

    // Get all matching users first (for shirt level filtering)
    let allUsers = await User.find(query).sort({ username: 1 });

    // Load games count for all users
    const userIds = allUsers.map(u => u._id);
    const gamesCountMap = await getPlayersGamesCount(userIds);

    // Add shirt level info to each user
    allUsers = allUsers.map(user => {
      const gamesPlayed = gamesCountMap[user._id.toString()] || 0;
      const shirtLevelInfo = getShirtLevel(gamesPlayed);
      return {
        ...user.toObject(),
        gamesPlayed,
        shirtLevel: shirtLevelInfo.level,
        shirtColor: shirtLevelInfo.color
      };
    });

    // Filter by shirt level if specified
    if (shirtLevel && shirtLevel !== 'all') {
      allUsers = allUsers.filter(user => user.shirtLevel === shirtLevel);
    }

    // Count total after filtering
    const total = allUsers.length;

    // Calculate total pages
    const totalPages = Math.ceil(total / limitNum);

    // Apply pagination
    const users = allUsers.slice(skip, skip + limitNum);

    res.render('admin/users', {
      title: 'Spieler verwalten',
      users,
      search,
      shirtLevel: shirtLevel || 'all',
      shirtLevels: SHIRT_LEVELS,
      moment,
      success: req.query.success || null,
      error: req.query.error || null,
      currentPage: pageNum,
      totalPages,
      hasNextPage: pageNum < totalPages,
      hasPrevPage: pageNum > 1,
      total
    });
  } catch (error) {
    console.error('Manage users error:', error);
    res.status(500).render('error', {
      title: 'Server Error',
      message: 'An error occurred while loading the users'
    });
  }
};

// @desc    Update user email
// @route   POST /admin/users/:id/update-email
// @access  Private (Admin only)
exports.updateUserEmail = async (req, res) => {
  try {
    const { id } = req.params;
    const { email } = req.body;

    if (!email || email.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'E-Mail-Adresse ist erforderlich'
      });
    }

    // E-Mail-Format validieren
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({
        success: false,
        message: 'Bitte geben Sie eine gültige E-Mail-Adresse ein'
      });
    }

    const user = await User.findById(id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Benutzer nicht gefunden'
      });
    }

    if (user.isAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Admin-E-Mail kann nicht geändert werden'
      });
    }

    // Prüfe, ob die E-Mail bereits von jemand anderem verwendet wird
    const existingEmail = await User.findOne({
      email: email.trim().toLowerCase(),
      _id: { $ne: id }
    });

    if (existingEmail) {
      return res.status(400).json({
        success: false,
        message: 'Diese E-Mail-Adresse wird bereits verwendet'
      });
    }

    // Update der E-Mail
    user.email = email.trim().toLowerCase();
    await user.save();

    return res.json({
      success: true,
      message: `E-Mail erfolgreich zu ${user.email} geändert`,
      newEmail: user.email
    });
  } catch (error) {
    console.error('Update user email error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Delete user
// @route   POST /admin/users/:id/delete
// @access  Private (Admin only)
exports.deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Find user
    const user = await User.findById(id);
    
    if (!user) {
      return res.redirect('/admin/users?error=Benutzer nicht gefunden');
    }
    
    if (user.isAdmin) {
      return res.redirect('/admin/users?error=Admin-Benutzer kann nicht gelöscht werden');
    }
    
    // Check if user has games
    const gamesCount = await Game.countDocuments({
      $or: [
        { 'team1.player': id },
        { 'team2.player': id }
      ]
    });
    
    if (gamesCount > 0) {
      return res.redirect('/admin/users?error=Benutzer mit Spielen kann nicht gelöscht werden. Lösche zuerst die Spiele.');
    }
    
    // Delete user
    await User.findByIdAndDelete(id);
    
    res.redirect('/admin/users?success=Benutzer erfolgreich gelöscht');
  } catch (error) {
    console.error('Delete user error:', error);
    res.redirect('/admin/users?error=Server error');
  }
};

// @desc    Toggle shirt distributed status for a user
// @route   POST /admin/users/:id/toggle-shirt
// @access  Private (Admin only)
exports.toggleShirtDistributed = async (req, res) => {
  try {
    const { id } = req.params;
    const { level } = req.body;

    if (!level) {
      return res.status(400).json({
        success: false,
        message: 'Trikotlevel ist erforderlich'
      });
    }

    const user = await User.findById(id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Benutzer nicht gefunden'
      });
    }

    // Initialize shirtsDistributed if it doesn't exist
    if (!user.shirtsDistributed) {
      user.shirtsDistributed = [];
    }

    // Check if this level was already distributed
    const existingIndex = user.shirtsDistributed.findIndex(s => s.level === level);

    if (existingIndex >= 0) {
      // Remove the distributed record (toggle off)
      user.shirtsDistributed.splice(existingIndex, 1);
      await user.save();
      return res.json({
        success: true,
        distributed: false,
        message: `${level}-Trikot wurde als nicht ausgeteilt markiert`
      });
    } else {
      // Add the distributed record (toggle on)
      user.shirtsDistributed.push({
        level: level,
        distributedAt: new Date()
      });
      await user.save();
      return res.json({
        success: true,
        distributed: true,
        message: `${level}-Trikot wurde als ausgeteilt markiert`
      });
    }
  } catch (error) {
    console.error('Toggle shirt distributed error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
};

// @desc    Manage games
// @route   GET /admin/games
// @access  Private (Admin only)
exports.manageGames = async (req, res) => {
  try {
    // Get query parameters
    const { userId, search, page = 1, limit = 10 } = req.query;
    
    // Convert page and limit to numbers
    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 10;
    const skip = (pageNum - 1) * limitNum;
    
    // Build query
    let query = {};
    
    // Filter by user if provided
    if (userId) {
      query = {
        $or: [
          { 'team1.player': userId },
          { 'team2.player': userId }
        ]
      };
    }
    
    // If search term is provided, get user ids that match the search
    if (search) {
      const matchingUsers = await User.find({
        username: { $regex: search, $options: 'i' },
        isAdmin: false
      }).select('_id');
      
      const userIds = matchingUsers.map(user => user._id);
      
      // If we already have a userId filter, combine with search
      if (userId) {
        // If the search doesn't match the selected user, return no results
        if (!userIds.some(id => id.toString() === userId)) {
          return res.render('admin/games', {
            title: 'Spiele verwalten',
            games: [],
            users: await User.find({ isAdmin: false }).sort({ username: 1 }).select('username'),
            selectedUserId: userId,
            search,
            moment,
            success: req.query.success || null,
            error: req.query.error || null,
            currentPage: pageNum,
            totalPages: 0,
            hasNextPage: false,
            hasPrevPage: false
          });
        }
      } else if (userIds.length > 0) {
        // Add search filter
        query = {
          $or: [
            { 'team1.player': { $in: userIds } },
            { 'team2.player': { $in: userIds } }
          ]
        };
      } else {
        // No matching users found, return no results
        return res.render('admin/games', {
          title: 'Spiele verwalten',
          games: [],
          users: await User.find({ isAdmin: false }).sort({ username: 1 }).select('username'),
          selectedUserId: userId,
          search,
          moment,
          success: req.query.success || null,
          error: req.query.error || null,
          currentPage: pageNum,
          totalPages: 0,
          hasNextPage: false,
          hasPrevPage: false
        });
      }
    }
    
    // Count total documents for pagination
    const total = await Game.countDocuments(query);
    
    // Calculate total pages
    const totalPages = Math.ceil(total / limitNum);
    
    // Get games with pagination
    const games = await Game.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .populate('team1.player team2.player createdBy', 'username');
    
    // Get all users for filter
    const users = await User.find({ isAdmin: false })
      .sort({ username: 1 })
      .select('username');
    
    res.render('admin/games', {
      title: 'Spiele verwalten',
      games,
      users,
      selectedUserId: userId,
      search,
      moment,
      success: req.query.success || null,
      error: req.query.error || null,
      currentPage: pageNum,
      totalPages,
      hasNextPage: pageNum < totalPages,
      hasPrevPage: pageNum > 1,
      total
    });
  } catch (error) {
    console.error('Manage games error:', error);
    res.status(500).render('error', { 
      title: 'Server Error',
      message: 'An error occurred while loading the games'
    });
  }
};

// @desc    Delete game
// @route   POST /admin/games/:id/delete
// @access  Private (Admin only)
exports.deleteGame = async (req, res) => {
  try {
    const { id } = req.params;

    // Find game
    const game = await Game.findById(id);

    if (!game) {
      return res.redirect('/admin/games?error=Spiel nicht gefunden');
    }

    // Delete any reports associated with this game
    await GameReport.deleteMany({ game: id });

    // Delete game
    await Game.findByIdAndDelete(id);

    // Full recalculation to ensure all subsequent games are correct
    await recalculateAllELO();

    const redirectUrl = req.query.userId
      ? `/admin/games?userId=${req.query.userId}&success=Spiel erfolgreich gelöscht und ELO neu berechnet`
      : '/admin/games?success=Spiel erfolgreich gelöscht und ELO neu berechnet';

    res.redirect(redirectUrl);
  } catch (error) {
    console.error('Delete game error:', error);
    res.redirect('/admin/games?error=Server error');
  }
};

// @desc    Manage registration requests
// @route   GET /admin/registration-requests
// @access  Private (Admin only)
exports.getRegistrationRequests = async (req, res) => {
  try {
    // Get query parameters
    const { page = 1, limit = 10 } = req.query;
    
    // Convert page and limit to numbers
    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 10;
    const skip = (pageNum - 1) * limitNum;
    
    // Count total pending requests
    const total = await RegistrationRequest.countDocuments({ status: 'pending' });
    
    // Calculate total pages
    const totalPages = Math.ceil(total / limitNum);
    
    // Get pending registration requests with pagination
    const requests = await RegistrationRequest.find({ status: 'pending' })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum);
    
    res.render('admin/registrationRequests', {
      title: 'Registrierungsanfragen',
      requests,
      moment,
      success: req.query.success || null,
      error: req.query.error || null,
      currentPage: pageNum,
      totalPages,
      hasNextPage: pageNum < totalPages,
      hasPrevPage: pageNum > 1,
      total
    });
  } catch (error) {
    console.error('Get registration requests error:', error);
    res.status(500).render('error', { 
      title: 'Server Error',
      message: 'An error occurred while loading the registration requests'
    });
  }
};

// @desc    Approve registration request
// @route   POST /admin/registration-requests/:id/approve
// @access  Private (Admin only)
exports.approveRegistrationRequest = async (req, res) => {
    try {
      const { id } = req.params;
      
      // Get the full request document with password
      const request = await RegistrationRequest.findById(id).select('+password');
      
      if (!request) {
        return res.redirect('/admin/registration-requests?error=Anfrage nicht gefunden');
      }
      
      if (request.status !== 'pending') {
        return res.redirect('/admin/registration-requests?error=Anfrage wurde bereits bearbeitet');
      }
      
      // Check for existing users
      const existingUsername = await User.findOne({ username: request.username });
      if (existingUsername) {
        return res.redirect('/admin/registration-requests?error=Benutzername existiert bereits');
      }
      
      const existingEmail = await User.findOne({ email: request.email });
      if (existingEmail) {
        return res.redirect('/admin/registration-requests?error=Email existiert bereits');
      }
      
 // Create user with direct DB operation to bypass Mongoose hooks
 const newUser = {
    username: request.username,
    email: request.email,
    password: request.password, // Already hashed
    eloRating: 500,
    isAdmin: false,
    createdAt: new Date(),
    lastActivity: new Date()
  };
  
  // Insert directly into MongoDB collection
  const result = await User.collection.insertOne(newUser);
  
  // Update request status
  request.status = 'approved';
  await request.save();
  
  // Success message
  console.log(`User ${request.username} successfully approved and created`);
  
  // Send approval email to user
  await sendRegistrationApprovedEmail({
    _id: result.insertedId,
    username: request.username,
    email: request.email
  });
  
  res.redirect('/admin/registration-requests?success=Registrierungsanfrage genehmigt');
    } catch (error) {
      console.error('Approve registration request error:', error);
      res.redirect('/admin/registration-requests?error=Server error');
    }
  };

// @desc    Reject registration request
// @route   POST /admin/registration-requests/:id/reject
// @access  Private (Admin only)
exports.rejectRegistrationRequest = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Find request
    const request = await RegistrationRequest.findById(id);
    
    if (!request) {
      return res.redirect('/admin/registration-requests?error=Anfrage nicht gefunden');
    }
    
    if (request.status !== 'pending') {
      return res.redirect('/admin/registration-requests?error=Anfrage wurde bereits bearbeitet');
    }
    
    // Update request status
    request.status = 'rejected';
    await request.save();
    
    res.redirect('/admin/registration-requests?success=Registrierungsanfrage abgelehnt');
  } catch (error) {
    console.error('Reject registration request error:', error);
    res.redirect('/admin/registration-requests?error=Server error');
  }
};

// @desc    Get all game reports
// @route   GET /admin/game-reports
// @access  Admin only
exports.getGameReports = async (req, res) => {
  try {
    // Get all game reports, sort by newest first
    const reports = await GameReport.find()
      .sort({ createdAt: -1 })
      .populate({
        path: 'game',
        populate: {
          path: 'team1.player team2.player createdBy',
          select: 'username'
        }
      })
      .populate('reportedBy', 'username email');
    
    res.render('admin/gameReports', {
      title: 'Gemeldete Spiele',
      reports,
      pendingRequestsCount: await RegistrationRequest.countDocuments({ status: 'pending' }),
      moment
    });
  } catch (error) {
    console.error('Get game reports error:', error);
    res.status(500).render('error', { 
      title: 'Server Error',
      message: 'An error occurred while loading the game reports'
    });
  }
};

// @desc    Delete a game report
// @route   POST /admin/game-reports/:id/delete
// @access  Admin only
exports.deleteGameReport = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Find and delete the report
    await GameReport.findByIdAndDelete(id);
    
    // Redirect back to game reports page with success message
    res.redirect('/admin/game-reports?success=Meldung erfolgreich gelöscht');
  } catch (error) {
    console.error('Delete game report error:', error);
    res.redirect('/admin/game-reports?error=Fehler beim Löschen der Meldung');
  }
};

// @desc    Reset all ELO ratings and delete all games
// @route   POST /admin/reset-system
// @access  Private (Admin only)
exports.resetSystem = async (req, res) => {
  let session = null;
  
  try {
    // Aktuelles Datum für den Reset der Aktivität
    const currentDate = new Date();
    
    // Try to use a transaction if available
    try {
      session = await mongoose.startSession();
      session.startTransaction();
      console.log('Using transaction for system reset');
      
      // 1. Reset all user ELO ratings to 500 and set lastActivity to current date
      const usersResult = await User.updateMany(
        { isAdmin: false }, // Only reset players, not admins
        {
          $set: {
            eloRating: 500,
            lastActivity: currentDate
          }
        },
        { session }
      );
      console.log(`Reset ELO ratings and activity for ${usersResult.modifiedCount} users`);
      
      // 2. Delete all games
      const gamesResult = await Game.deleteMany({}, { session });
      console.log(`Deleted ${gamesResult.deletedCount} games`);
      
      // 3. Delete all game reports
      const reportsResult = await GameReport.deleteMany({}, { session });
      console.log(`Deleted ${reportsResult.deletedCount} game reports`);
      
      // 4. Delete all quarterly ELO records
      const quarterlyResult = await QuarterlyELO.deleteMany({}, { session });
      console.log(`Deleted ${quarterlyResult.deletedCount} quarterly ELO records`);
      
      // Commit the transaction
      await session.commitTransaction();
      console.log('Transaction committed successfully');
    } catch (transactionError) {
      if (session) {
        await session.abortTransaction();
      }
      
      // If transaction failed, fallback to non-transactional approach
      console.log('Transaction not supported or failed, falling back to regular operations:', transactionError.message);
      
      // 1. Reset all user ELO ratings to 500 and lastActivity to current date
      const usersResult = await User.updateMany(
        { isAdmin: false },
        {
          $set: {
            eloRating: 500,
            lastActivity: currentDate
          }
        }
      );
      console.log(`Reset ELO ratings and activity for ${usersResult.modifiedCount} users`);
      
      // 2. Delete all games
      const gamesResult = await Game.deleteMany({});
      console.log(`Deleted ${gamesResult.deletedCount} games`);
      
      // 3. Delete all game reports
      const reportsResult = await GameReport.deleteMany({});
      console.log(`Deleted ${reportsResult.deletedCount} game reports`);
      
      // 4. Delete all quarterly ELO records
      const quarterlyResult = await QuarterlyELO.deleteMany({});
      console.log(`Deleted ${quarterlyResult.deletedCount} quarterly ELO records`);
    } finally {
      if (session) {
        session.endSession();
      }
    }
    
    // Log the successful reset
    console.log('System successfully reset by admin:', req.user.username);
    
    // Redirect with success message
    res.redirect('/admin/dashboard?success=System wurde erfolgreich zurückgesetzt. Alle Spieler haben nun 500 ELO-Punkte, alle Spiele wurden gelöscht und alle Spieler sind wieder aktiv.');
  } catch (error) {
    console.error('System reset error:', error);
    res.redirect('/admin/dashboard?error=Beim Zurücksetzen des Systems ist ein Fehler aufgetreten: ' + error.message);
  }
};

// @desc    Recalculate all ELO ratings for the current quarter
// @route   POST /admin/recalculate-elo
// @access  Private (Admin only)
exports.recalculateELO = async (req, res) => {
  try {
    // Full recalculation from scratch - processes ALL games ever
    await recalculateAllELO();

    res.redirect('/admin/dashboard?success=ELO-Werte für alle Spiele wurden erfolgreich neu berechnet');
  } catch (error) {
    console.error('ELO recalculation error:', error);
    res.redirect('/admin/dashboard?error=Bei der ELO-Neuberechnung ist ein Fehler aufgetreten: ' + error.message);
  }
};

/**
 * Helper function to get updated player information for a game
 * @param {Object} game - Game object with populated player references
 * @returns {Object} - Object containing current player information for ELO calculation
 */
async function getPlayersInfo(game) {
  // Get current player data from database
  const player1 = await User.findById(game.team1[0].player._id);
  const player2 = await User.findById(game.team1[1].player._id);
  const player3 = await User.findById(game.team2[0].player._id);
  const player4 = await User.findById(game.team2[1].player._id);
  
  return {
    team1: {
      player1: player1,
      player2: player2
    },
    team2: {
      player1: player3,
      player2: player4
    }
  };
}

/**
 * Recalculate ELO for a game using current player ELO values
 * @param {Object} playersInfo - Current player information
 * @param {Object} score - Score object with team1 and team2 scores
 * @returns {Object} - Calculated ELO results
 */
function recalculateGameELO(playersInfo, score) {
  const { calculateEloForMatch } = require('../utils/eloCalculator');
  return calculateEloForMatch(playersInfo.team1, playersInfo.team2, score);
}

// @desc    Get email export page with all user emails
// @route   GET /admin/email-export
// @access  Private (Admin only)
exports.getEmailExport = async (req, res) => {
  try {
    // Get all non-admin users with username and email
    const users = await User.find({ isAdmin: false }).select('username email').sort({ username: 1 });

    // Extract emails only (comma separated)
    const emailList = users.map(user => user.email).join(', ');

    // Extract name + email (CSV format, one per line)
    const nameEmailList = users.map(user => `${user.username}, ${user.email}`).join('\n');

    const emailCount = users.length;

    res.render('admin/emailExport', {
      title: 'E-Mail Export',
      emailList,
      nameEmailList,
      emailCount,
      pendingRequestsCount: await RegistrationRequest.countDocuments({ status: 'pending' })
    });
  } catch (error) {
    console.error('Email export error:', error);
    res.status(500).render('error', {
      title: 'Server Error',
      message: 'An error occurred while loading the email export'
    });
  }
};

// ===========================
// PADEL SCHEDULE FUNCTIONS (VEREINFACHT)
// ===========================

// @desc    Get padel schedule management page
// @route   GET /admin/padel-schedule
// @access  Private (Admin only)
exports.getPadelSchedule = async (req, res) => {
  try {
    // Get all users für Spieler-Auswahl
    const allUsers = await User.find({ isAdmin: false }).sort({ eloRating: -1 });

    // Get the latest schedule - erst ohne populate um die originale ID-Reihenfolge zu erhalten
    const scheduleRaw = await PadelSchedule.findOne()
      .sort({ createdAt: -1 });

    let schedule = null;
    if (scheduleRaw) {
      // Speichere die originale Reihenfolge der Spieler-IDs
      const originalPlayerOrder = scheduleRaw.players.map(id => id.toString());

      // Jetzt mit populate laden
      schedule = await PadelSchedule.findById(scheduleRaw._id)
        .populate('players', 'username eloRating')
        .populate('createdBy publishedBy', 'username');

      // WICHTIG: Stelle die originale Reihenfolge der Spieler wieder her
      // (Mongoose populate garantiert nicht die Reihenfolge!)
      if (schedule.players && schedule.players.length > 0) {
        const playersMap = new Map(schedule.players.map(p => [p._id.toString(), p]));
        schedule.players = originalPlayerOrder
          .map(id => playersMap.get(id))
          .filter(p => p); // Filter out any undefined
      }
    }

    // Prüfe ob veröffentlichter Schedule abgelaufen ist (3h nach Startzeit ODER nach 23:00 am Spieltag)
    if (schedule && schedule.isPublished && schedule.startTime) {
      const now = new Date();
      const startTime = new Date(schedule.startTime);

      // Spieltag Ende: 23:00 Uhr am Tag der Startzeit
      const gameDay = new Date(startTime);
      gameDay.setHours(23, 0, 0, 0);

      // Deaktiviere 3 Stunden nach Startzeit ODER nach 23:00 am Spieltag
      const threeHoursAfterStart = new Date(startTime.getTime() + 3 * 60 * 60 * 1000);
      const deactivationTime = new Date(Math.min(threeHoursAfterStart.getTime(), gameDay.getTime()));

      if (now > deactivationTime) {
        schedule.isPublished = false;
        await schedule.save();
      }
    }

    // Generiere die Matchups wenn ein Schedule existiert
    let scheduleCourts = null;
    if (schedule && schedule.players && schedule.players.length >= 4) {
      // Lade die Anzahl der Spiele für jeden Spieler (neue Spieler kommen in die schlechteste Gruppe)
      const playerIds = schedule.players.map(p => p._id);
      const gamesCountMap = await getPlayersGamesCount(playerIds);
      scheduleCourts = generateScheduleMatchups(schedule.players, schedule.courtNames, gamesCountMap, schedule.manualOrder || false);
    }

    res.render('admin/scheduleManagement', {
      title: 'Padel Spielplan',
      schedule: schedule || null,
      scheduleCourts: scheduleCourts,
      allUsers,
      moment,
      success: req.query.success || null,
      error: req.query.error || null
    });
  } catch (error) {
    console.error('Get padel schedule error:', error);
    res.status(500).render('error', {
      title: 'Server Error',
      message: 'Fehler beim Laden des Spielplans'
    });
  }
};

/**
 * Generate matchups für einen gespeicherten Schedule
 * @param {Array} players - Array von populated User-Objekten
 * @param {Array} courtNames - Array von Court-Namen
 * @param {Object} gamesCountMap - Map von Spieler-ID zu Anzahl Spiele (optional)
 * @param {Boolean} manualOrder - Wenn true, wird die Spieler-Reihenfolge beibehalten (keine Sortierung)
 * @returns {Array} - Array von Court-Assignments
 */
function generateScheduleMatchups(players, courtNames = [], gamesCountMap = null, manualOrder = false) {
  if (!players || players.length < 4 || players.length % 4 !== 0) {
    return null;
  }

  let orderedPlayers;

  if (manualOrder) {
    // Behalte die manuelle Reihenfolge bei
    // Format: [Court1_Team1_P1, Court1_Team1_P2, Court1_Team2_P1, Court1_Team2_P2, Court2_Team1_P1, ...]
    orderedPlayers = [...players];
  } else {
    // Sortiere Spieler: Normale nach ELO, neue Spieler (0 Spiele) ans Ende
    if (gamesCountMap) {
      orderedPlayers = sortPlayersForSchedule(players, gamesCountMap);
    } else {
      // Fallback: Einfache ELO-Sortierung wenn keine gamesCountMap vorhanden
      orderedPlayers = [...players].sort((a, b) => b.eloRating - a.eloRating);
    }
  }

  const courts = [];
  const numCourts = orderedPlayers.length / 4;

  for (let courtIndex = 0; courtIndex < numCourts; courtIndex++) {
    const courtPlayers = orderedPlayers.slice(courtIndex * 4, (courtIndex + 1) * 4);

    let team1, team2;
    if (manualOrder) {
      // Bei manueller Reihenfolge: [0,1] = Team 1, [2,3] = Team 2
      team1 = [courtPlayers[0], courtPlayers[1]];
      team2 = [courtPlayers[2], courtPlayers[3]];
    } else {
      // Bei automatischer Sortierung: Stärkster+Schwächster vs Mitte
      team1 = [courtPlayers[0], courtPlayers[3]];
      team2 = [courtPlayers[1], courtPlayers[2]];
    }

    const team1Elo = Math.round((team1[0].eloRating + team1[1].eloRating) / 2);
    const team2Elo = Math.round((team2[0].eloRating + team2[1].eloRating) / 2);

    courts.push({
      courtNumber: courtIndex + 1,
      courtName: courtNames[courtIndex] || `Platz ${courtIndex + 1}`,
      team1: team1.map(player => ({
        username: player.username,
        elo: player.eloRating,
        isNewPlayer: gamesCountMap ? (gamesCountMap[player._id.toString()] || 0) === 0 : false
      })),
      team2: team2.map(player => ({
        username: player.username,
        elo: player.eloRating,
        isNewPlayer: gamesCountMap ? (gamesCountMap[player._id.toString()] || 0) === 0 : false
      })),
      team1Elo,
      team2Elo,
      eloDifference: Math.abs(team1Elo - team2Elo)
    });
  }

  return courts;
}

// @desc    Create or update padel schedule
// @route   POST /admin/padel-schedule/save
// @access  Private (Admin only)
exports.savePadelSchedule = async (req, res) => {
  try {
    const { players, startTime, manualOrder } = req.body;

    // Validate
    if (!players || !Array.isArray(players) || players.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Bitte wählen Sie mindestens einen Spieler'
      });
    }

    if (!startTime) {
      return res.status(400).json({
        success: false,
        message: 'Bitte geben Sie eine Startzeit an'
      });
    }

    // Konvertiere startTime zu Date-Objekt (aus Schweizer Zeitzone)
    // datetime-local sendet Format: "2025-11-21T16:25"
    // Wir müssen es als Schweizer Zeit interpretieren, nicht als UTC
    const startDate = moment.tz(startTime, 'Europe/Zurich').toDate();

    // Hole Court-Namen aus dem Request (optional)
    const { courtNames } = req.body;

    // Get or create schedule
    let schedule = await PadelSchedule.findOne();

    if (!schedule) {
      schedule = new PadelSchedule({
        players,
        startTime: startDate,
        createdBy: req.user._id,
        isPublished: false,
        courtNames: courtNames || [],
        manualOrder: manualOrder || false
      });
    } else {
      schedule.players = players;
      schedule.startTime = startDate;
      schedule.courtNames = courtNames || [];
      schedule.manualOrder = manualOrder || false;
      schedule.updatedAt = new Date();
    }

    await schedule.save();

    res.json({
      success: true,
      message: 'Spielplan erfolgreich erstellt'
    });
  } catch (error) {
    console.error('Save padel schedule error:', error);
    res.status(500).json({
      success: false,
      message: 'Fehler beim Speichern des Spielplans: ' + error.message
    });
  }
};

// @desc    Publish padel schedule (make it active and show on dashboardTV)
// @route   POST /admin/padel-schedule/publish
// @access  Private (Admin only)
exports.publishPadelSchedule = async (req, res) => {
  try {
    const schedule = await PadelSchedule.findOne()
      .sort({ createdAt: -1 });

    if (!schedule || !schedule.players || schedule.players.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Bitte erstellen Sie zuerst einen Spielplan'
      });
    }

    // Deactivate any previously published schedules
    await PadelSchedule.updateMany({}, { isPublished: false });

    // Publish this schedule
    schedule.isPublished = true;
    schedule.publishedAt = new Date();
    schedule.publishedBy = req.user._id;
    await schedule.save();

    res.json({
      success: true,
      message: 'Spielplan erfolgreich veröffentlicht'
    });
  } catch (error) {
    console.error('Publish padel schedule error:', error);
    res.status(500).json({
      success: false,
      message: 'Fehler beim Veröffentlichen des Spielplans: ' + error.message
    });
  }
};

// @desc    Get published schedule API (for dashboardTV)
// @route   GET /api/padel-schedule
// @access  Public
exports.getActiveScheduleAPI = async (req, res) => {
  try {
    // Erst ohne populate laden um die originale ID-Reihenfolge zu erhalten
    const scheduleRaw = await PadelSchedule.findOne({ isPublished: true });

    if (!scheduleRaw) {
      return res.json({ isPublished: false, schedule: null });
    }

    // Speichere die originale Reihenfolge der Spieler-IDs
    const originalPlayerOrder = scheduleRaw.players.map(id => id.toString());

    // Jetzt mit populate laden
    const schedule = await PadelSchedule.findById(scheduleRaw._id)
      .populate('players', 'username eloRating profileImage')
      .populate('createdBy publishedBy', 'username');

    // WICHTIG: Stelle die originale Reihenfolge der Spieler wieder her
    // (Mongoose populate garantiert nicht die Reihenfolge!)
    if (schedule.players && schedule.players.length > 0) {
      const playersMap = new Map(schedule.players.map(p => [p._id.toString(), p]));
      schedule.players = originalPlayerOrder
        .map(id => playersMap.get(id))
        .filter(p => p); // Filter out any undefined
    }

    const now = new Date();
    const startTime = new Date(schedule.startTime);
    const publishedAt = schedule.publishedAt ? new Date(schedule.publishedAt) : now;

    // Spieltag: Datum des Spielstarts (nur Datum, ohne Uhrzeit)
    const gameDay = new Date(startTime);
    gameDay.setHours(0, 0, 0, 0);

    // Tag der Veröffentlichung (nur Datum, ohne Uhrzeit)
    const publishDay = new Date(publishedAt);
    publishDay.setHours(0, 0, 0, 0);

    // Ende ist immer 23:00 Uhr am Spieltag
    const displayEndTime = new Date(gameDay);
    displayEndTime.setHours(23, 0, 0, 0);

    // Start-Zeitpunkt bestimmen:
    // - Wenn am Spieltag veröffentlicht: Sofort (publishedAt)
    // - Wenn am Vortag oder früher veröffentlicht: 9:00 Uhr am Spieltag
    let displayStartTime;
    if (publishDay.getTime() >= gameDay.getTime()) {
      // Am Spieltag (oder später) veröffentlicht -> sofort
      displayStartTime = publishedAt;
    } else {
      // Vor dem Spieltag veröffentlicht -> 9:00 Uhr am Spieltag
      displayStartTime = new Date(gameDay);
      displayStartTime.setHours(9, 0, 0, 0);
    }

    // Deaktivierungszeit: Immer 23:00 Uhr am Spieltag
    const deactivationTime = displayEndTime;

    // Prüfe ob wir im Zeitfenster sind
    if (now < displayStartTime || now > deactivationTime) {
      // Außerhalb des Zeitfensters - deaktiviere wenn Zeit abgelaufen
      if (now > deactivationTime) {
        schedule.isPublished = false;
        await schedule.save();
      }
      return res.json({ isPublished: false, schedule: null });
    }

    // Spieler sortieren oder manuelle Reihenfolge beibehalten
    const playerIds = schedule.players.map(p => p._id);
    const gamesCountMap = await getPlayersGamesCount(playerIds);

    // Wenn manualOrder true ist, behalte die gespeicherte Reihenfolge bei
    // Format: [Court1_Team1_P1, Court1_Team1_P2, Court1_Team2_P1, Court1_Team2_P2, ...]
    const orderedPlayers = schedule.manualOrder
      ? [...schedule.players]  // Manuelle Reihenfolge beibehalten
      : sortPlayersForSchedule(schedule.players, gamesCountMap);  // Nach ELO sortieren

    res.json({
      isPublished: true,
      schedule: {
        _id: schedule._id,
        startTime: schedule.startTime,
        players: orderedPlayers.map(p => ({
          username: p.username,
          eloRating: p.eloRating,
          profileImage: p.profileImage,
          isNewPlayer: (gamesCountMap[p._id.toString()] || 0) === 0
        })),
        publishedAt: schedule.publishedAt,
        publishedBy: schedule.publishedBy?.username,
        courtNames: schedule.courtNames || [],
        manualOrder: schedule.manualOrder || false
      }
    });
  } catch (error) {
    console.error('Get active schedule API error:', error);
    res.json({ isPublished: false, schedule: null });
  }
};

// @desc    Delete a padel schedule
// @route   DELETE /admin/padel-schedule/:id
// @access  Private (Admin only)
exports.deletePadelSchedule = async (req, res) => {
  try {
    const { id } = req.params;

    const schedule = await PadelSchedule.findById(id);

    if (!schedule) {
      return res.status(404).json({
        success: false,
        message: 'Spielplan nicht gefunden'
      });
    }

    await PadelSchedule.findByIdAndDelete(id);

    res.json({
      success: true,
      message: 'Spielplan erfolgreich gelöscht'
    });
  } catch (error) {
    console.error('Delete padel schedule error:', error);
    res.status(500).json({
      success: false,
      message: 'Fehler beim Löschen des Spielplans: ' + error.message
    });
  }
};

// @desc    Update padel schedule start time
// @route   PUT /admin/padel-schedule/:id/start-time
// @access  Private (Admin only)
exports.updatePadelScheduleStartTime = async (req, res) => {
  try {
    const { id } = req.params;
    const { startTime } = req.body;

    if (!startTime) {
      return res.status(400).json({
        success: false,
        message: 'Bitte geben Sie eine Startzeit an'
      });
    }

    const schedule = await PadelSchedule.findById(id);

    if (!schedule) {
      return res.status(404).json({
        success: false,
        message: 'Spielplan nicht gefunden'
      });
    }

    // Konvertiere startTime zu Date-Objekt (aus Schweizer Zeitzone)
    const startDate = moment.tz(startTime, 'Europe/Zurich').toDate();

    schedule.startTime = startDate;
    schedule.updatedAt = new Date();

    // Wenn veröffentlicht, aktualisiere auch publishedAt für korrektes Zeitfenster
    if (schedule.isPublished) {
      schedule.publishedAt = new Date();
    }

    await schedule.save();

    res.json({
      success: true,
      message: 'Startzeit erfolgreich aktualisiert',
      newStartTime: moment(startDate).tz('Europe/Zurich').format('DD.MM.YYYY HH:mm')
    });
  } catch (error) {
    console.error('Update padel schedule start time error:', error);
    res.status(500).json({
      success: false,
      message: 'Fehler beim Aktualisieren der Startzeit: ' + error.message
    });
  }
};

// @desc    Delete all past padel schedules (startTime in the past and not published)
// @route   DELETE /admin/padel-schedule/past
// @access  Private (Admin only)
exports.deletePastPadelSchedules = async (req, res) => {
  try {
    const now = new Date();

    // Lösche alle Spielpläne, deren Startzeit in der Vergangenheit liegt
    // und die nicht mehr veröffentlicht sind
    const result = await PadelSchedule.deleteMany({
      startTime: { $lt: now },
      isPublished: false
    });

    res.json({
      success: true,
      message: `${result.deletedCount} vergangene Spielpläne erfolgreich gelöscht`,
      deletedCount: result.deletedCount
    });
  } catch (error) {
    console.error('Delete past padel schedules error:', error);
    res.status(500).json({
      success: false,
      message: 'Fehler beim Löschen vergangener Spielpläne: ' + error.message
    });
  }
};

// @desc    Send notification email to all players in the schedule
// @route   POST /admin/padel-schedule/notify
// @access  Private (Admin only)
exports.sendScheduleNotification = async (req, res) => {
  try {
    // Erst ohne populate laden um die originale ID-Reihenfolge zu erhalten
    const scheduleRaw = await PadelSchedule.findOne()
      .sort({ createdAt: -1 });

    if (!scheduleRaw || !scheduleRaw.players || scheduleRaw.players.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Kein Spielplan mit Spielern gefunden'
      });
    }

    // Speichere die originale Reihenfolge der Spieler-IDs
    const originalPlayerOrder = scheduleRaw.players.map(id => id.toString());

    // Jetzt mit populate laden
    const schedule = await PadelSchedule.findById(scheduleRaw._id)
      .populate('players', 'username eloRating email');

    // WICHTIG: Stelle die originale Reihenfolge der Spieler wieder her
    // (Mongoose populate garantiert nicht die Reihenfolge!)
    if (schedule.players && schedule.players.length > 0) {
      const playersMap = new Map(schedule.players.map(p => [p._id.toString(), p]));
      schedule.players = originalPlayerOrder
        .map(id => playersMap.get(id))
        .filter(p => p); // Filter out any undefined
    }

    // Generate matchups for the email - respektiere manuelle Reihenfolge!
    const playerIds = schedule.players.map(p => p._id);
    const gamesCountMap = await getPlayersGamesCount(playerIds);

    // Verwende generateScheduleMatchups um konsistente Ergebnisse zu erhalten
    const courts = generateScheduleMatchups(
      schedule.players,
      schedule.courtNames || [],
      gamesCountMap,
      schedule.manualOrder || false
    );

    if (!courts) {
      return res.status(400).json({
        success: false,
        message: 'Fehler beim Generieren der Spielpaarungen für E-Mail'
      });
    }

    // Send emails
    await sendScheduleNotificationEmail(schedule, courts);

    res.json({
      success: true,
      message: `E-Mail erfolgreich an ${schedule.players.length} Spieler gesendet`
    });
  } catch (error) {
    console.error('Send schedule notification error:', error);
    res.status(500).json({
      success: false,
      message: 'Fehler beim Senden der Benachrichtigungen: ' + error.message
    });
  }
};

// ===========================
// AWARD MANAGEMENT FUNCTIONS
// ===========================

// @desc    Get awards management page
// @route   GET /admin/awards
// @access  Private (Admin only)
exports.getAwardsPage = async (req, res) => {
  try {
    // Get all users with their awards
    const users = await User.find({ isAdmin: false })
      .select('username awards')
      .sort({ username: 1 });

    // Get award types and available quarters
    const awardTypes = getAllAwardTypes();
    const availableQuarters = getAvailableQuarters();

    res.render('admin/awards', {
      title: 'Awards verwalten',
      users,
      awardTypes,
      availableQuarters,
      getAwardInfo,
      moment,
      success: req.query.success || null,
      error: req.query.error || null
    });
  } catch (error) {
    console.error('Get awards page error:', error);
    res.status(500).render('error', {
      title: 'Server Error',
      message: 'Fehler beim Laden der Awards-Seite'
    });
  }
};

// @desc    Grant an award to a user
// @route   POST /admin/awards/grant
// @access  Private (Admin only)
exports.grantAward = async (req, res) => {
  try {
    const { userId, awardType, quarter, year } = req.body;

    if (!userId || !awardType || !quarter || !year) {
      return res.status(400).json({
        success: false,
        message: 'Alle Felder sind erforderlich'
      });
    }

    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Benutzer nicht gefunden'
      });
    }

    // Check if user already has this award for this quarter/year
    const existingAward = user.awards.find(
      a => a.type === awardType && a.quarter === quarter && a.year === parseInt(year)
    );

    if (existingAward) {
      return res.status(400).json({
        success: false,
        message: `${user.username} hat diesen Award für ${quarter} ${year} bereits erhalten`
      });
    }

    // Add the award
    user.awards.push({
      type: awardType,
      quarter: quarter,
      year: parseInt(year),
      awardedAt: new Date()
    });

    await user.save();

    const awardInfo = getAwardInfo(awardType);

    res.json({
      success: true,
      message: `${awardInfo.name} wurde an ${user.username} vergeben`,
      award: {
        type: awardType,
        quarter,
        year: parseInt(year),
        userName: user.username
      }
    });
  } catch (error) {
    console.error('Grant award error:', error);
    res.status(500).json({
      success: false,
      message: 'Fehler beim Vergeben des Awards'
    });
  }
};

// @desc    Auto-distribute awards for a quarter
// @route   POST /admin/awards/auto-distribute
// @access  Private (Admin only)
exports.autoDistributeAwards = async (req, res) => {
  try {
    const { quarter, year } = req.body;

    if (!quarter || !year) {
      return res.status(400).json({
        success: false,
        message: 'Quartal und Jahr sind erforderlich'
      });
    }

    // Convert quarter string (Q1, Q2, Q3, Q4) to number (0, 1, 2, 3)
    const quarterNum = parseInt(quarter.replace('Q', '')) - 1;

    // Call the distribute function
    await distributeQuarterlyAwards({ year: parseInt(year), quarter: quarterNum });

    res.json({
      success: true,
      message: `Awards für ${quarter} ${year} wurden automatisch verteilt`
    });
  } catch (error) {
    console.error('Auto distribute awards error:', error);
    res.status(500).json({
      success: false,
      message: 'Fehler bei der automatischen Award-Verteilung'
    });
  }
};

// @desc    Remove an award from a user
// @route   POST /admin/awards/remove
// @access  Private (Admin only)
exports.removeAward = async (req, res) => {
  try {
    const { userId, awardType, quarter, year } = req.body;

    if (!userId || !awardType || !quarter || !year) {
      return res.status(400).json({
        success: false,
        message: 'Alle Felder sind erforderlich'
      });
    }

    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Benutzer nicht gefunden'
      });
    }

    // Find and remove the award
    const awardIndex = user.awards.findIndex(
      a => a.type === awardType && a.quarter === quarter && a.year === parseInt(year)
    );

    if (awardIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'Award nicht gefunden'
      });
    }

    user.awards.splice(awardIndex, 1);
    await user.save();

    const awardInfo = getAwardInfo(awardType);

    res.json({
      success: true,
      message: `${awardInfo.name} wurde von ${user.username} entfernt`
    });
  } catch (error) {
    console.error('Remove award error:', error);
    res.status(500).json({
      success: false,
      message: 'Fehler beim Entfernen des Awards'
    });
  }
};

// ==================== Umkleide Display ====================

const umkleideItemToJSON = (item) => ({
  id: item._id,
  kind: item.kind,
  url: `/umkleide-media/${item.fileId}`,
  poster: item.posterId ? `/umkleide-media/${item.posterId}` : null,
  duration: item.duration || null,
  size: item.size || null,
  originalName: item.originalName,
  active: item.active
});

exports.getUmkleideDisplay = async (req, res) => {
  try {
    const settings = await UmkleideSetting.getSettings();
    const pendingRequestsCount = await RegistrationRequest.countDocuments({ status: 'pending' });
    const items = settings.items.map(umkleideItemToJSON);
    const totalBytes = settings.items.reduce((sum, item) => sum + (item.size || 0), 0);
    res.render('admin/umkleideDisplay', {
      title: 'Umkleide Display',
      settings,
      items,
      totalBytes,
      user: req.user,
      pendingRequestsCount,
      success: req.query.success || null,
      error: req.query.error || null
    });
  } catch (error) {
    console.error('Get umkleide display error:', error);
    res.status(500).render('error', {
      title: 'Server Error',
      message: 'Fehler beim Laden der Umkleide-Einstellungen'
    });
  }
};

exports.uploadUmkleideItems = async (req, res) => {
  const files = req.files || [];
  try {
    if (files.length === 0) {
      return res.redirect('/admin/umkleide-display?error=Keine Dateien ausgewählt');
    }
    const settings = await UmkleideSetting.getSettings();
    const existingNames = settings.items.map(item => item.originalName);
    const skipped = [];
    const failed = [];
    let added = 0;

    for (const file of files) {
      try {
        if (existingNames.includes(file.originalname)) {
          skipped.push(file.originalname);
          continue;
        }

        const processed = umkleideMedia.isVideo(file.mimetype)
          ? await umkleideMedia.processVideo(file.path, file.originalname)
          : await umkleideMedia.processImage(file.path, file.originalname);

        settings.items.push({
          ...processed,
          originalName: file.originalname,
          active: true
        });
        existingNames.push(file.originalname);
        added++;
      } catch (error) {
        console.error(`Umkleide upload: ${file.originalname} fehlgeschlagen –`, error.message);
        failed.push(file.originalname);
      } finally {
        await umkleideMedia.removeTempFile(file.path);
      }
    }
    await settings.save();

    const notes = [];
    if (skipped.length > 0) notes.push('Übersprungen (bereits vorhanden): ' + skipped.join(', '));
    if (failed.length > 0) notes.push('Fehlgeschlagen: ' + failed.join(', '));
    if (notes.length > 0) {
      const prefix = added > 0 ? `${added} Datei(en) hochgeladen. ` : '';
      return res.redirect('/admin/umkleide-display?error=' + encodeURIComponent(prefix + notes.join(' · ')));
    }
    res.redirect('/admin/umkleide-display?success=' + encodeURIComponent(`${added} Datei(en) erfolgreich hochgeladen`));
  } catch (error) {
    console.error('Upload umkleide items error:', error);
    await Promise.all(files.map(file => umkleideMedia.removeTempFile(file.path)));
    res.redirect('/admin/umkleide-display?error=Fehler beim Hochladen');
  }
};

exports.deleteUmkleideItem = async (req, res) => {
  try {
    const settings = await UmkleideSetting.getSettings();
    const item = settings.items.id(req.params.id);
    if (!item) {
      return res.status(404).json({ success: false, message: 'Eintrag nicht gefunden' });
    }
    await umkleideMedia.deleteFile(item.fileId);
    await umkleideMedia.deleteFile(item.posterId);
    settings.items.pull({ _id: req.params.id });
    await settings.save();
    res.json({ success: true, message: 'Eintrag gelöscht' });
  } catch (error) {
    console.error('Delete umkleide item error:', error);
    res.status(500).json({ success: false, message: 'Fehler beim Löschen' });
  }
};

exports.deleteAllUmkleideItems = async (req, res) => {
  try {
    const settings = await UmkleideSetting.getSettings();
    for (const item of settings.items) {
      await umkleideMedia.deleteFile(item.fileId);
      await umkleideMedia.deleteFile(item.posterId);
    }
    settings.items = [];
    await settings.save();
    res.json({ success: true, message: 'Alle Einträge gelöscht' });
  } catch (error) {
    console.error('Delete all umkleide items error:', error);
    res.status(500).json({ success: false, message: 'Fehler beim Löschen' });
  }
};

exports.toggleUmkleideItem = async (req, res) => {
  try {
    const settings = await UmkleideSetting.getSettings();
    const item = settings.items.id(req.params.id);
    if (!item) {
      return res.status(404).json({ success: false, message: 'Eintrag nicht gefunden' });
    }
    item.active = !item.active;
    await settings.save();
    res.json({ success: true, active: item.active });
  } catch (error) {
    console.error('Toggle umkleide item error:', error);
    res.status(500).json({ success: false, message: 'Fehler beim Umschalten' });
  }
};

exports.updateUmkleideInterval = async (req, res) => {
  try {
    const { interval } = req.body;
    if (!interval || interval < 1) {
      return res.status(400).json({ success: false, message: 'Ungültiges Intervall' });
    }
    const settings = await UmkleideSetting.getSettings();
    settings.interval = parseInt(interval);
    await settings.save();
    res.json({ success: true, interval: settings.interval });
  } catch (error) {
    console.error('Update umkleide interval error:', error);
    res.status(500).json({ success: false, message: 'Fehler beim Aktualisieren' });
  }
};

exports.getUmkleideItemsAPI = async (req, res) => {
  try {
    const settings = await UmkleideSetting.getSettings();
    const items = settings.items
      .filter(item => item.active)
      .map(item => {
        const json = umkleideItemToJSON(item);
        return { kind: json.kind, url: json.url, poster: json.poster, duration: json.duration };
      });
    res.set('Cache-Control', 'no-store');
    res.json({ items, interval: settings.interval });
  } catch (error) {
    console.error('Get umkleide items API error:', error);
    res.status(500).json({ items: [], interval: 10 });
  }
};

exports.streamUmkleideMedia = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.fileId)) {
      return res.status(404).end();
    }
    await umkleideMedia.streamToResponse(req.params.fileId, req, res);
  } catch (error) {
    console.error('Stream umkleide media error:', error);
    if (!res.headersSent) res.status(500).end();
  }
};
