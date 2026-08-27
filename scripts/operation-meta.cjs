// Public-facing English descriptions and risk warnings for every operation.
//
// Shared by scripts/generate-manifest.js and scripts/normalize.js so that the
// manifest and the normalized spec carry identical, machine-checkable metadata.
//
// Keep strings in English, free of secrets and PII. Sensitive operations MUST
// include a warning mentioning "sensitive", "login token", and "approval" so
// that scripts/validate.js can verify it.

"use strict";

/**
 * @typedef {Object} OperationMeta
 * @property {string} description English description of the operation.
 * @property {string} [warning] Risk warning appended to the description.

 * @type {Record<string, OperationMeta>}
 */
const OPERATION_META = {
  AccessGroupsGetList: { description: "List access groups with optional filters by teacher, group class, or individual class." },
  AccessGroupsGetDetails: { description: "Get details of a single access group by id." },
  AccessGroupsGetTeachers: { description: "List teachers assigned to an access group (paginated)." },
  AccessGroupsGetIndividualClasses: { description: "List individual classes linked to an access group (paginated)." },
  AccessGroupsGetGroupClasses: { description: "List group classes linked to an access group (paginated)." },
  AccessGroupsCreate: { description: "Create a new access group." },
  AccessGroupsDelete: { description: "Delete an access group.", warning: "Destructive: removes the access group. Requires client-side approval." },
  AccessGroupsAddMembers: { description: "Add members to an access group." },
  AccessGroupsRemoveMembers: { description: "Remove members from an access group.", warning: "Destructive: unlinks members from the group. Requires client-side approval." },
  BooksGetBooksPlatform: { description: "List books available on the platform." },
  BooksGetBooksSchool: { description: "List books available to the current school." },
  BooksGetBook: { description: "Get a single book by id." },
  BooksPinLessonToClass: { description: "Pin a lesson from a book to a class." },
  ClassesGetStatistics: { description: "Get class statistics." },
  GroupClassesGetList: { description: "List group classes with optional filters and pagination." },
  GroupClassesGetDetail: { description: "Get details of a single group class by id." },
  GroupClassesCreate: { description: "Create a new group class." },
  GroupClassesUpdate: { description: "Update an existing group class." },
  GroupClassesChangeTeacher: { description: "Change the teacher assigned to a group class." },
  GroupClassesDelete: { description: "Delete a group class.", warning: "Destructive: removes the group class. Requires client-side approval." },
  GroupClassPupilsGetList: { description: "List pupils in a group class (paginated)." },
  GroupClassPupilsAdd: { description: "Add pupils to a group class. Adding a pupil to a group class activates the pupil and consumes the school's tariff limit of activated students. The limit depends on the school's tariff plan. Exceeding it returns HTTP 400 \"The number of activated students has been exceeded\"." },
  GroupClassPupilsDelete: { description: "Remove a pupil from a group class.", warning: "Destructive: unlinks the pupil from the group class. Requires client-side approval." },
  IndividualClassesGetList: { description: "List individual classes with optional filters and pagination." },
  IndividualClassesGetDetail: { description: "Get details of a single individual class by id." },
  IndividualClassesChangeTeacher: { description: "Change the teacher assigned to an individual class." },
  IndividualClassesCreate: { description: "Create a new individual class." },
  IndividualClassesUpdate: { description: "Update an existing individual class." },
  IndividualClassesDelete: { description: "Delete an individual class.", warning: "Destructive: removes the individual class. Requires client-side approval." },
  LessonPackagesGetList: { description: "List lesson packages for a pupil and/or class." },
  LessonPackagesSetPackage: { description: "Set a lesson package for a pupil and class." },
  LessonPackagesUpdatePackagePeriod: { description: "Update the period of a lesson package." },
  LessonPackagesWriteOffLessons: { description: "Write off lessons from a package.", warning: "Destructive: decrements lesson balance. Requires client-side approval." },
  LessonTariffsGetList: { description: "List lesson tariffs (paginated, with soft-deleted filter)." },
  LessonTariffsGetTariffForDurationId: { description: "Get a lesson tariff by its duration id." },
  LessonTariffsCreate: { description: "Create a new lesson tariff." },
  LessonTariffsDelete: { description: "Delete a lesson tariff.", warning: "Destructive: removes the tariff. Requires client-side approval." },
  LessonTariffsAddTariffDuration: { description: "Add a duration option to a lesson tariff." },
  LessonTariffsGetTariffDurationList: { description: "List lesson tariff durations (paginated)." },
  LessonTariffsDeleteTariffDuration: { description: "Delete a tariff duration.", warning: "Destructive: removes the tariff duration. Requires client-side approval." },
  LessonTariffsDeleteLessonPackage: { description: "Delete a lesson package attached to a tariff.", warning: "Destructive: removes the lesson package. Requires client-side approval." },
  MarathonChangeActivationMarathonPupil: { description: "Activate or deactivate a pupil in a marathon.", warning: "Destructive: changes pupil activation state in a marathon. Requires client-side approval." },
  MarathonGetMarathonList: { description: "List marathons (paginated, with search and folder filter)." },
  MarathonGetMarathonStudents: { description: "List students in a marathon with search and filter." },
  MarathonAddMarathonNewStudents: { description: "Add new students to a marathon by email. Note: this is a GET that mutates state.", warning: "Mutates state: invites new students to a marathon. Requires client-side approval." },
  MarathonCreateModerator: { description: "Create a marathon moderator." },
  MarathonDeleteModerator: { description: "Delete a marathon moderator.", warning: "Destructive: removes the moderator. Requires client-side approval." },
  MarathonSetPupilsForModerator: { description: "Assign pupils to a marathon moderator." },
  MarathonSetModeratorsForPupil: { description: "Assign moderators to a marathon pupil." },
  MarathonUnsetPupilsForModerator: { description: "Unassign pupils from a marathon moderator.", warning: "Destructive: unlinks pupils from the moderator. Requires client-side approval." },
  MarathonUnsetModeratorsForPupil: { description: "Unassign moderators from a marathon pupil.", warning: "Destructive: unlinks moderators from the pupil. Requires client-side approval." },
  MarathonGetModerators: { description: "List marathon moderators (paginated)." },
  PupilsGetList: { description: "List pupils with search, filters and pagination." },
  PupilsGetCursorList: { description: "List pupils using cursor-based pagination." },
  PupilsGetDetail: { description: "Get details of a single pupil by id." },
  PupilsCreate: { description: "Create a new pupil." },
  PupilsUpdate: { description: "Update an existing pupil." },
  PupilsDelete: { description: "Delete a pupil. The pupil must be unlinked from all classes first: remove from group classes via GroupClassPupilsDelete and delete individual classes via IndividualClassesDelete. Upstream returns HTTP 400 \"Pupil have classes\" if any class link remains.", warning: "Destructive: removes the pupil. Requires client-side approval." },
  PupilTagGetList: { description: "List all pupil tags." },
  PupilTagCreate: { description: "Create a new pupil tag." },
  PupilTagDelete: { description: "Delete a pupil tag.", warning: "Destructive: removes the tag. Requires client-side approval." },
  ScheduleGetSchoolSchedule: { description: "Get the school schedule for a date range." },
  ScheduleGetPupilSchedule: { description: "Get a pupil's schedule for a date range." },
  ScheduleGetTeacherWeekWorkTime: { description: "Get a teacher's weekly work time." },
  ScheduleGetSchoolWeekWorkTime: { description: "Get the school's weekly work time." },
  ScheduleGetPackageForIndividualLesson: { description: "Get the lesson package applicable to an individual lesson." },
  ScheduleGetPackageForGroupLesson: { description: "Get the lesson package applicable to a group lesson." },
  ScheduleGetTeacherSchedule: { description: "Get a teacher's schedule for a date range in a given timezone." },
  ScheduleCreateLesson: { description: "Create a new lesson in the schedule. The `groupId` field accepts the id of any class (group or individual). Creating a lesson may activate the pupil as a side effect (response includes `isActivatedPupil`)." },
  ScheduleDeleteLesson: { description: "Delete a lesson from the schedule.", warning: "Destructive: removes the lesson. Requires client-side approval." },
  TeachersGetList: { description: "List teachers with search and pagination." },
  TeachersGetDetail: { description: "Get details of a single teacher by id." },
  TeachersCreate: { description: "Create a new teacher." },
  TeachersUpdate: { description: "Update an existing teacher." },
  TeachersDelete: { description: "Delete a teacher.", warning: "Destructive: removes the teacher. Requires client-side approval." },
  UserAuthLoginPupil: { description: "Authenticate a pupil and return a login token.", warning: "Sensitive: returns a login token. Public enablement requires recorded product/security approval. The token must never be logged, cached, or returned outside the direct successful tool result." },
  UserAuthLoginTeacher: { description: "Authenticate a teacher and return a login token.", warning: "Sensitive: returns a login token. Public enablement requires recorded product/security approval. The token must never be logged, cached, or returned outside the direct successful tool result." },
  UserAuthCheckAuthToken: { description: "Check whether an auth token is valid." },
};

/** Build the final description string (description + warning). */
function descriptionFor(operationId) {
  const meta = OPERATION_META[operationId];
  if (!meta) return "";
  const parts = [meta.description];
  if (meta.warning) parts.push(`WARNING: ${meta.warning}`);
  return parts.join("\n\n");
}

module.exports = { OPERATION_META, descriptionFor };
