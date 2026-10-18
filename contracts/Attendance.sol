// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Attendance
 * @notice Decentralized attendance system.
 *  - The deployer is the admin (owner) and can add / remove teachers.
 *  - Students register themselves with a name and a unique roll number.
 *  - Teachers open attendance sessions with a time window.
 *  - Students mark themselves present once per session, inside the window.
 *  - Everything is stored on-chain and publicly verifiable.
 */
contract Attendance {
    // ───────────── Types ─────────────
    struct Student {
        string name;
        string rollNo;
        bool registered;
        uint64 registeredAt;
    }

    struct Session {
        uint256 id;
        string title;
        address teacher;
        uint64 startTime;
        uint64 endTime;
        bool closed;
        uint256 presentCount;
    }

    // ───────────── Storage ─────────────
    address public owner;

    mapping(address => bool) public isTeacher;
    address[] private teacherList;

    mapping(address => Student) private students;
    mapping(bytes32 => bool) private rollTaken;
    address[] private studentList;

    Session[] private sessions;
    mapping(uint256 => mapping(address => bool)) public hasAttended;
    mapping(uint256 => address[]) private attendees;
    mapping(address => uint256[]) private studentSessions;

    // ───────────── Events ─────────────
    event TeacherAdded(address indexed teacher);
    event TeacherRemoved(address indexed teacher);
    event StudentRegistered(address indexed student, string name, string rollNo);
    event SessionCreated(
        uint256 indexed sessionId,
        address indexed teacher,
        string title,
        uint64 startTime,
        uint64 endTime
    );
    event SessionClosed(uint256 indexed sessionId);
    event AttendanceMarked(
        uint256 indexed sessionId,
        address indexed student,
        uint64 timestamp
    );
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event SessionExtended(uint256 indexed sessionId, uint64 newEndTime);
    event AttendanceOverridden(
        uint256 indexed sessionId,
        address indexed student,
        address indexed by
    );

    // ───────────── Modifiers ─────────────
    modifier onlyOwner() {
        require(msg.sender == owner, "Only admin");
        _;
    }

    modifier onlyTeacher() {
        require(isTeacher[msg.sender], "Only teacher");
        _;
    }

    constructor() {
        owner = msg.sender;
        // The admin is also a teacher so a single account can try the whole flow.
        isTeacher[msg.sender] = true;
        teacherList.push(msg.sender);
        emit TeacherAdded(msg.sender);
    }

    // ───────────── Admin ─────────────
    function addTeacher(address teacher) external onlyOwner {
        require(teacher != address(0), "Zero address");
        require(!isTeacher[teacher], "Already teacher");
        isTeacher[teacher] = true;
        teacherList.push(teacher);
        emit TeacherAdded(teacher);
    }

    function removeTeacher(address teacher) external onlyOwner {
        require(isTeacher[teacher], "Not a teacher");
        require(teacher != owner, "Cannot remove admin");
        isTeacher[teacher] = false;
        uint256 len = teacherList.length;
        for (uint256 i = 0; i < len; i++) {
            if (teacherList[i] == teacher) {
                teacherList[i] = teacherList[len - 1];
                teacherList.pop();
                break;
            }
        }
        emit TeacherRemoved(teacher);
    }

    /// @notice Hand the admin role to another account (new admin also becomes a teacher).
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero address");
        require(newOwner != owner, "Already admin");
        address previous = owner;
        owner = newOwner;
        if (!isTeacher[newOwner]) {
            isTeacher[newOwner] = true;
            teacherList.push(newOwner);
            emit TeacherAdded(newOwner);
        }
        emit OwnershipTransferred(previous, newOwner);
    }

    // ───────────── Students ─────────────
    function registerStudent(string calldata name, string calldata rollNo) external {
        require(!students[msg.sender].registered, "Already registered");
        require(bytes(name).length > 0 && bytes(name).length <= 64, "Bad name");
        require(bytes(rollNo).length > 0 && bytes(rollNo).length <= 32, "Bad roll no");
        bytes32 rollHash = keccak256(bytes(rollNo));
        require(!rollTaken[rollHash], "Roll no already used");

        rollTaken[rollHash] = true;
        students[msg.sender] = Student(name, rollNo, true, uint64(block.timestamp));
        studentList.push(msg.sender);
        emit StudentRegistered(msg.sender, name, rollNo);
    }

    // ───────────── Sessions ─────────────
    /// @param durationMinutes how long students can mark attendance (1 - 1440)
    function createSession(string calldata title, uint64 durationMinutes)
        external
        onlyTeacher
        returns (uint256 id)
    {
        require(bytes(title).length > 0 && bytes(title).length <= 100, "Bad title");
        require(durationMinutes > 0 && durationMinutes <= 1440, "Bad duration");

        id = sessions.length;
        uint64 start = uint64(block.timestamp);
        uint64 end = start + durationMinutes * 60;
        sessions.push(Session(id, title, msg.sender, start, end, false, 0));
        emit SessionCreated(id, msg.sender, title, start, end);
    }

    function closeSession(uint256 sessionId) external {
        require(sessionId < sessions.length, "No such session");
        Session storage s = sessions[sessionId];
        require(msg.sender == s.teacher || msg.sender == owner, "Not allowed");
        require(!s.closed, "Already closed");
        s.closed = true;
        emit SessionClosed(sessionId);
    }

    function markAttendance(uint256 sessionId) external {
        require(students[msg.sender].registered, "Register first");
        require(sessionId < sessions.length, "No such session");
        Session storage s = sessions[sessionId];
        require(!s.closed, "Session closed");
        require(block.timestamp >= s.startTime, "Not started");
        require(block.timestamp <= s.endTime, "Session ended");
        require(!hasAttended[sessionId][msg.sender], "Already marked");

        _record(sessionId, msg.sender);
    }

    /// @notice Teacher of the session (or admin) marks a student present manually,
    ///         e.g. when the student had a wallet problem. Works even after the window ended.
    function markStudentPresent(uint256 sessionId, address student) external {
        require(sessionId < sessions.length, "No such session");
        Session storage s = sessions[sessionId];
        require(msg.sender == s.teacher || msg.sender == owner, "Not allowed");
        require(students[student].registered, "Student not registered");
        require(!hasAttended[sessionId][student], "Already marked");

        _record(sessionId, student);
        emit AttendanceOverridden(sessionId, student, msg.sender);
    }

    /// @notice Give students more time. Only for sessions that are not closed.
    /// @param extraMinutes minutes added on top of the current end (or on top of "now" if already ended)
    function extendSession(uint256 sessionId, uint64 extraMinutes) external {
        require(sessionId < sessions.length, "No such session");
        Session storage s = sessions[sessionId];
        require(msg.sender == s.teacher || msg.sender == owner, "Not allowed");
        require(!s.closed, "Session closed");
        require(extraMinutes > 0 && extraMinutes <= 1440, "Bad duration");

        uint64 base = s.endTime > uint64(block.timestamp) ? s.endTime : uint64(block.timestamp);
        s.endTime = base + extraMinutes * 60;
        emit SessionExtended(sessionId, s.endTime);
    }

    function _record(uint256 sessionId, address who) private {
        hasAttended[sessionId][who] = true;
        attendees[sessionId].push(who);
        studentSessions[who].push(sessionId);
        sessions[sessionId].presentCount += 1;
        emit AttendanceMarked(sessionId, who, uint64(block.timestamp));
    }

    // ───────────── Views ─────────────
    function sessionCount() external view returns (uint256) {
        return sessions.length;
    }

    function studentCount() external view returns (uint256) {
        return studentList.length;
    }

    function getSession(uint256 sessionId) external view returns (Session memory) {
        require(sessionId < sessions.length, "No such session");
        return sessions[sessionId];
    }

    function getAllSessions() external view returns (Session[] memory) {
        return sessions;
    }

    function isSessionOpen(uint256 sessionId) public view returns (bool) {
        if (sessionId >= sessions.length) return false;
        Session storage s = sessions[sessionId];
        return !s.closed && block.timestamp >= s.startTime && block.timestamp <= s.endTime;
    }

    function getStudent(address who) external view returns (Student memory) {
        return students[who];
    }

    function getTeachers() external view returns (address[] memory) {
        return teacherList;
    }

    function getStudents() external view returns (address[] memory) {
        return studentList;
    }

    function getAttendees(uint256 sessionId) external view returns (address[] memory) {
        require(sessionId < sessions.length, "No such session");
        return attendees[sessionId];
    }

    function getStudentSessions(address who) external view returns (uint256[] memory) {
        return studentSessions[who];
    }

    /// @notice Sessions in the range [offset, offset + limit), oldest first.
    function getSessionsPage(uint256 offset, uint256 limit)
        external
        view
        returns (Session[] memory page)
    {
        uint256 total = sessions.length;
        if (offset >= total) return new Session[](0);
        uint256 count = total - offset;
        if (limit < count) count = limit;
        page = new Session[](count);
        for (uint256 i = 0; i < count; i++) {
            page[i] = sessions[offset + i];
        }
    }

    /// @notice present[i] is true if `who` attended session i.
    function getStudentReport(address who) external view returns (bool[] memory present) {
        uint256 total = sessions.length;
        present = new bool[](total);
        for (uint256 i = 0; i < total; i++) {
            present[i] = hasAttended[i][who];
        }
    }

    /// @return attended number of sessions the student was present in
    /// @return total total number of sessions created
    function getAttendanceStats(address who)
        external
        view
        returns (uint256 attended, uint256 total)
    {
        return (studentSessions[who].length, sessions.length);
    }
}
