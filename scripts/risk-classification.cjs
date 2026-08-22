// Authoritative risk classification for all 78 Edvibe School API operations.
//
// This is the SINGLE human-authored input for normalization. It is reproduced
// from CONTEXT.md "Полный инвентарь 78 операций" and must match the control sum:
//   35 read + 24 write + 17 high-risk + 2 sensitive = 78.
//
// Risk is determined by actual operation semantics, NOT by HTTP method.
// Notably:
//   - GET /api/Marathon/AddMarathonNewStudents mutates state -> "write".
//   - Eight read-only operations use POST.
//
// Do not edit the upstream OpenAPI snapshot. This map drives the manifest and
// the normalized spec via scripts/normalize.js.

"use strict";

/** @typedef {"read"|"write"|"high-risk"|"sensitive"} RiskClass */

/**
 * Map of "METHOD /api/Path" -> RiskClass.
 * Keys are normalized as "GET /api/AccessGroups/GetList" (uppercase method, exact upstream path).
 * @type {Record<string, RiskClass>}
 */
const RISK_BY_OPERATION = {
  // AccessGroups
  "GET /api/AccessGroups/GetList": "read",
  "GET /api/AccessGroups/GetDetails": "read",
  "GET /api/AccessGroups/GetTeachers": "read",
  "GET /api/AccessGroups/GetIndividualClasses": "read",
  "GET /api/AccessGroups/GetGroupClasses": "read",
  "POST /api/AccessGroups/Create": "write",
  "POST /api/AccessGroups/Delete": "high-risk",
  "POST /api/AccessGroups/AddMembers": "write",
  "POST /api/AccessGroups/RemoveMembers": "high-risk",
  // Books
  "POST /api/Books/GetBooksPlatform": "read",
  "POST /api/Books/GetBooksSchool": "read",
  "POST /api/Books/GetBook": "read",
  "POST /api/Books/PinLessonToClass": "write",
  // Classes
  "POST /api/Classes/GetStatistics": "read",
  // GroupClasses
  "GET /api/GroupClasses/GetList": "read",
  "GET /api/GroupClasses/GetDetail": "read",
  "POST /api/GroupClasses/Create": "write",
  "POST /api/GroupClasses/Update": "write",
  "POST /api/GroupClasses/ChangeTeacher": "write",
  "POST /api/GroupClasses/Delete": "high-risk",
  // GroupClassPupils
  "GET /api/GroupClassPupils/GetList": "read",
  "POST /api/GroupClassPupils/Add": "write",
  "POST /api/GroupClassPupils/Delete": "high-risk",
  // IndividualClasses
  "GET /api/IndividualClasses/GetList": "read",
  "GET /api/IndividualClasses/GetDetail": "read",
  "POST /api/IndividualClasses/ChangeTeacher": "write",
  "POST /api/IndividualClasses/Create": "write",
  "POST /api/IndividualClasses/Update": "write",
  "POST /api/IndividualClasses/Delete": "high-risk",
  // LessonPackages
  "GET /api/LessonPackages/GetList": "read",
  "POST /api/LessonPackages/SetPackage": "write",
  "POST /api/LessonPackages/UpdatePackagePeriod": "write",
  "POST /api/LessonPackages/WriteOffLessons": "high-risk",
  // LessonTariffs
  "GET /api/LessonTariffs/GetList": "read",
  "GET /api/LessonTariffs/GetTariffForDurationId": "read",
  "POST /api/LessonTariffs/Create": "write",
  "POST /api/LessonTariffs/Delete": "high-risk",
  "POST /api/LessonTariffs/AddTariffDuration": "write",
  "GET /api/LessonTariffs/GetTariffDurationList": "read",
  "POST /api/LessonTariffs/DeleteTariffDuration": "high-risk",
  "POST /api/LessonTariffs/DeleteLessonPackage": "high-risk",
  // Marathon
  "POST /api/Marathon/ChangeActivationMarathonPupil": "high-risk",
  "GET /api/Marathon/GetMarathonList": "read",
  "GET /api/Marathon/GetMarathonStudents": "read",
  "GET /api/Marathon/AddMarathonNewStudents": "write",
  "POST /api/Marathon/CreateModerator": "write",
  "POST /api/Marathon/DeleteModerator": "high-risk",
  "POST /api/Marathon/SetPupilsForModerator": "write",
  "POST /api/Marathon/SetModeratorsForPupil": "write",
  "POST /api/Marathon/UnsetPupilsForModerator": "high-risk",
  "POST /api/Marathon/UnsetModeratorsForPupil": "high-risk",
  "GET /api/Marathon/GetModerators": "read",
  // Pupils
  "GET /api/Pupils/GetList": "read",
  "GET /api/Pupils/GetCursorList": "read",
  "GET /api/Pupils/GetDetail": "read",
  "POST /api/Pupils/Create": "write",
  "POST /api/Pupils/Update": "write",
  "POST /api/Pupils/Delete": "high-risk",
  // PupilTag
  "GET /api/PupilTag/GetList": "read",
  "POST /api/PupilTag/Create": "write",
  "POST /api/PupilTag/Delete": "high-risk",
  // Schedule
  "POST /api/Schedule/GetSchoolSchedule": "read",
  "POST /api/Schedule/GetPupilSchedule": "read",
  "GET /api/Schedule/GetTeacherWeekWorkTime": "read",
  "GET /api/Schedule/GetSchoolWeekWorkTime": "read",
  "GET /api/Schedule/GetPackageForIndividualLesson": "read",
  "GET /api/Schedule/GetPackageForGroupLesson": "read",
  "POST /api/Schedule/GetTeacherSchedule": "read",
  "POST /api/Schedule/CreateLesson": "write",
  "POST /api/Schedule/DeleteLesson": "high-risk",
  // Teachers
  "GET /api/Teachers/GetList": "read",
  "GET /api/Teachers/GetDetail": "read",
  "POST /api/Teachers/Create": "write",
  "POST /api/Teachers/Update": "write",
  "POST /api/Teachers/Delete": "high-risk",
  // UserAuth
  "POST /api/UserAuth/LoginPupil": "sensitive",
  "POST /api/UserAuth/LoginTeacher": "sensitive",
  "POST /api/UserAuth/CheckAuthToken": "read",
};

/** Expected control sums. */
const EXPECTED_COUNTS = {
  total: 78,
  read: 35,
  write: 24,
  "high-risk": 17,
  sensitive: 2,
};

module.exports = { RISK_BY_OPERATION, EXPECTED_COUNTS };
