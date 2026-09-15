const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const { adminLimiter } = require('../middleware/rateLimitMiddleware');
const {
  getDashboard,
  manageUsers,
  deleteUser,
  updateUserEmail,
  toggleShirtDistributed,
  manageGames,
  deleteGame,
  getRegistrationRequests,
  approveRegistrationRequest,
  rejectRegistrationRequest,
  getGameReports,
  deleteGameReport,
  resetSystem,
  recalculateELO,
  getEmailExport,
  getPadelSchedule,
  savePadelSchedule,
  publishPadelSchedule,
  deletePadelSchedule,
  deletePastPadelSchedules,
  updatePadelScheduleStartTime,
  getActiveScheduleAPI,
  sendScheduleNotification,
  getAwardsPage,
  grantAward,
  removeAward,
  autoDistributeAwards,
  getUmkleideDisplay,
  uploadUmkleideItems,
  deleteUmkleideItem,
  deleteAllUmkleideItems,
  toggleUmkleideItem,
  updateUmkleideInterval
} = require('../controllers/adminController');
const { upload: umkleideUpload, handleUploadError: handleUmkleideUploadError } = require('../middleware/umkleideUpload');

// Apply admin protection to all routes
router.use(protect);
router.use(authorize('admin'));

// Dashboard route
router.get('/dashboard', getDashboard);

// User management routes
router.get('/users', manageUsers);
router.post('/users/:id/delete', deleteUser);
router.post('/users/:id/update-email', updateUserEmail);
router.post('/users/:id/toggle-shirt', toggleShirtDistributed);

// Game management routes
router.get('/games', manageGames);
router.post('/games/:id/delete', deleteGame);

// Registration request routes
router.get('/registration-requests', getRegistrationRequests);
router.post('/registration-requests/:id/approve', approveRegistrationRequest);
router.post('/registration-requests/:id/reject', rejectRegistrationRequest);

router.get('/game-reports', getGameReports);
router.post('/game-reports/:id/delete', deleteGameReport);

// Email export route
router.get('/email-export', getEmailExport);

router.post('/reset-system', adminLimiter, resetSystem);
router.post('/recalculate-elo', adminLimiter, recalculateELO);

// Padel Schedule routes - WICHTIG: Spezifische Routen MÜSSEN vor :id Routen kommen!
router.get('/padel-schedule', getPadelSchedule);
router.post('/padel-schedule/save', savePadelSchedule);
router.post('/padel-schedule/publish', publishPadelSchedule);
router.post('/padel-schedule/notify', sendScheduleNotification);  // E-Mail an alle Spieler
router.delete('/padel-schedule/past', deletePastPadelSchedules);  // Muss vor /:id kommen!
router.put('/padel-schedule/:id/start-time', updatePadelScheduleStartTime);
router.delete('/padel-schedule/:id', deletePadelSchedule);

// Award routes
router.get('/awards', getAwardsPage);
router.post('/awards/grant', grantAward);
router.post('/awards/remove', removeAward);
router.post('/awards/auto-distribute', autoDistributeAwards);

// Umkleide Display routes
router.get('/umkleide-display', getUmkleideDisplay);
router.post('/umkleide-display/upload', umkleideUpload.array('files', 10), handleUmkleideUploadError, uploadUmkleideItems);
router.delete('/umkleide-display/all', deleteAllUmkleideItems);
router.post('/umkleide-display/:id/toggle', toggleUmkleideItem);
router.delete('/umkleide-display/:id', deleteUmkleideItem);
router.put('/umkleide-display/interval', updateUmkleideInterval);

module.exports = router;