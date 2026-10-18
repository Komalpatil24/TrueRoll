const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Attendance", function () {
  let attendance, admin, teacher, alice, bob, stranger;

  beforeEach(async () => {
    [admin, teacher, alice, bob, stranger] = await ethers.getSigners();
    const F = await ethers.getContractFactory("Attendance");
    attendance = await F.deploy();
    await attendance.waitForDeployment();
    await attendance.addTeacher(teacher.address);
    await attendance.connect(alice).registerStudent("Alice", "R001");
    await attendance.connect(bob).registerStudent("Bob", "R002");
  });

  it("sets the deployer as admin and teacher", async () => {
    expect(await attendance.owner()).to.equal(admin.address);
    expect(await attendance.isTeacher(admin.address)).to.equal(true);
  });

  it("only admin can add or remove teachers", async () => {
    await expect(
      attendance.connect(alice).addTeacher(stranger.address)
    ).to.be.revertedWith("Only admin");
    await attendance.removeTeacher(teacher.address);
    expect(await attendance.isTeacher(teacher.address)).to.equal(false);
  });

  it("registers students and blocks duplicates", async () => {
    const s = await attendance.getStudent(alice.address);
    expect(s.name).to.equal("Alice");
    expect(s.rollNo).to.equal("R001");
    await expect(
      attendance.connect(alice).registerStudent("Alice2", "R999")
    ).to.be.revertedWith("Already registered");
    await expect(
      attendance.connect(stranger).registerStudent("Eve", "R001")
    ).to.be.revertedWith("Roll no already used");
    expect(await attendance.studentCount()).to.equal(2);
  });

  it("only teachers can create sessions", async () => {
    await expect(
      attendance.connect(alice).createSession("Math", 10)
    ).to.be.revertedWith("Only teacher");
    await attendance.connect(teacher).createSession("Math", 10);
    const s = await attendance.getSession(0);
    expect(s.title).to.equal("Math");
    expect(s.teacher).to.equal(teacher.address);
    expect(await attendance.sessionCount()).to.equal(1);
  });

  it("lets a registered student mark attendance once", async () => {
    await attendance.connect(teacher).createSession("Math", 10);
    await attendance.connect(alice).markAttendance(0);
    expect(await attendance.hasAttended(0, alice.address)).to.equal(true);
    await expect(
      attendance.connect(alice).markAttendance(0)
    ).to.be.revertedWith("Already marked");
    await expect(
      attendance.connect(stranger).markAttendance(0)
    ).to.be.revertedWith("Register first");

    const s = await attendance.getSession(0);
    expect(s.presentCount).to.equal(1);
    expect(Array.from(await attendance.getAttendees(0))).to.deep.equal([alice.address]);

    const [attended, total] = await attendance.getAttendanceStats(alice.address);
    expect(attended).to.equal(1);
    expect(total).to.equal(1);
  });

  it("rejects attendance after the window ends", async () => {
    await attendance.connect(teacher).createSession("Math", 5);
    await time.increase(6 * 60);
    expect(await attendance.isSessionOpen(0)).to.equal(false);
    await expect(
      attendance.connect(alice).markAttendance(0)
    ).to.be.revertedWith("Session ended");
  });

  it("rejects attendance after a session is closed", async () => {
    await attendance.connect(teacher).createSession("Math", 30);
    await attendance.connect(teacher).closeSession(0);
    await expect(
      attendance.connect(alice).markAttendance(0)
    ).to.be.revertedWith("Session closed");
    await expect(
      attendance.connect(bob).closeSession(0)
    ).to.be.revertedWith("Not allowed");
  });

  it("tracks stats across several sessions", async () => {
    await attendance.connect(teacher).createSession("Math", 30);
    await attendance.connect(teacher).createSession("Physics", 30);
    await attendance.connect(teacher).createSession("Chem", 30);
    await attendance.connect(bob).markAttendance(0);
    await attendance.connect(bob).markAttendance(2);
    const [attended, total] = await attendance.getAttendanceStats(bob.address);
    expect(attended).to.equal(2);
    expect(total).to.equal(3);
    const ids = await attendance.getStudentSessions(bob.address);
    expect(ids.map((x) => Number(x))).to.deep.equal([0, 2]);
  });

  describe("extra features", function () {
    it("lets the admin transfer ownership", async () => {
      await expect(
        attendance.connect(alice).transferOwnership(alice.address)
      ).to.be.revertedWith("Only admin");
      await expect(attendance.transferOwnership(ethers.ZeroAddress)).to.be.revertedWith("Zero address");
      await expect(attendance.transferOwnership(admin.address)).to.be.revertedWith("Already admin");
      await expect(attendance.transferOwnership(stranger.address))
        .to.emit(attendance, "OwnershipTransferred")
        .withArgs(admin.address, stranger.address);
      expect(await attendance.owner()).to.equal(stranger.address);
      expect(await attendance.isTeacher(stranger.address)).to.equal(true);
      // old admin lost admin rights
      await expect(attendance.addTeacher(alice.address)).to.be.revertedWith("Only admin");
      await attendance.connect(stranger).addTeacher(alice.address);
    });

    it("lets the session teacher or admin mark a student present manually", async () => {
      await attendance.connect(teacher).createSession("Math", 5);
      await expect(
        attendance.connect(bob).markStudentPresent(0, alice.address)
      ).to.be.revertedWith("Not allowed");
      await expect(
        attendance.connect(teacher).markStudentPresent(0, stranger.address)
      ).to.be.revertedWith("Student not registered");

      // works even after the window ended
      await time.increase(6 * 60);
      await expect(attendance.connect(teacher).markStudentPresent(0, alice.address))
        .to.emit(attendance, "AttendanceOverridden")
        .withArgs(0, alice.address, teacher.address);
      expect(await attendance.hasAttended(0, alice.address)).to.equal(true);
      expect((await attendance.getSession(0)).presentCount).to.equal(1);
      await expect(
        attendance.connect(teacher).markStudentPresent(0, alice.address)
      ).to.be.revertedWith("Already marked");
      await attendance.markStudentPresent(0, bob.address); // admin may too
      expect((await attendance.getSession(0)).presentCount).to.equal(2);
    });

    it("extends a session", async () => {
      await attendance.connect(teacher).createSession("Math", 5);
      const before = (await attendance.getSession(0)).endTime;
      await attendance.connect(teacher).extendSession(0, 10);
      const after = (await attendance.getSession(0)).endTime;
      expect(after - before).to.equal(600n);

      await expect(attendance.connect(bob).extendSession(0, 5)).to.be.revertedWith("Not allowed");
      await expect(attendance.connect(teacher).extendSession(0, 0)).to.be.revertedWith("Bad duration");

      // an ended session can be reopened by extending
      await time.increase(20 * 60);
      expect(await attendance.isSessionOpen(0)).to.equal(false);
      await attendance.connect(teacher).extendSession(0, 5);
      expect(await attendance.isSessionOpen(0)).to.equal(true);
      await attendance.connect(alice).markAttendance(0);

      // closed sessions cannot be extended
      await attendance.connect(teacher).closeSession(0);
      await expect(attendance.connect(teacher).extendSession(0, 5)).to.be.revertedWith("Session closed");
    });

    it("returns paged sessions and a per-student report", async () => {
      for (const t of ["A", "B", "C"]) await attendance.connect(teacher).createSession(t, 30);
      await attendance.connect(alice).markAttendance(1);

      const page = await attendance.getSessionsPage(1, 5);
      expect(page.map((s) => s.title)).to.deep.equal(["B", "C"]);
      expect((await attendance.getSessionsPage(3, 5)).length).to.equal(0);
      expect((await attendance.getSessionsPage(0, 2)).length).to.equal(2);

      expect(Array.from(await attendance.getStudentReport(alice.address))).to.deep.equal([false, true, false]);
    });
  });
});
