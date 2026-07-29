package app.prompter.tablet.ui.prompter

import app.prompter.tablet.protocol.*
import org.junit.Assert.*
import org.junit.Test

class MovementFollowControllerTest {
    private val follow = RuntimeFollowSettings(true, .5f, 800f, .5f, 18f, "animate")

    @Test fun `normal movement uses a visible configured duration`() {
        val plan = planSmoothFollow(600f, 2200, follow)
        assertTrue(plan.shouldAnimate)
        assertTrue(plan.durationMs >= 750)
        assertEquals("catch-up", plan.policy)
    }

    @Test fun `small movement remains inside dead zone and explicit large snap is honored`() {
        assertEquals("dead-zone", planSmoothFollow(10f, 1000, follow).policy)
        assertEquals("snap", planSmoothFollow(2000f, 1000, follow.copy(largeCorrectionPolicy = "snap")).policy)
    }
    private fun snapshot(content: String = "First paragraph has enough words to create several bounded chunks for movement testing.") = SessionSnapshot(
        3, 2,
        ManuscriptPayload("m", "hash", content, paragraphs = listOf(ParagraphAnchor(0, CharacterRange(0, content.length), 0, 1)), sentences = listOf(SentenceAnchor(0, 0, CharacterRange(0, content.length), 0, 1)), tokens = listOf(TokenAnchor(0, 0, 0, CharacterRange(0, 5)))),
        Position(0, 0, 0, 0), "following", .9, displayHints = DisplayHints()
    )
    private fun movement(
        character: Int,
        paragraph: Int = 0,
        sentence: Int = 0,
        manuscriptRevision: Long = 2,
        tokenIndex: Int = 0,
        classification: String = "on-track",
        manualStatus: String? = null,
        manualAnchor: Int? = null,
        manualDistance: Int? = null
    ) = MovementEvent(
        3, manuscriptRevision, tokenIndex, tokenIndex, character, sentence, paragraph, .9, 500,
        classification, "test", manualStatus, manualAnchor, manualDistance
    )
    private fun anchor(
        tokenIndex: Int,
        paragraph: Int = 0,
        sentence: Int = 0,
        character: Int = tokenIndex * 6
    ) = TabletVisibleAnchor(tokenIndex, character, sentence, paragraph, 0f)

    @Test fun `semantic target resolves to bounded manuscript chunk`() {
        val snapshot = snapshot()
        val chunks = manuscriptChunks(snapshot, maxCharacters = 24)
        val resolved = resolveMovementTarget(snapshot, chunks, movement(45)) as MovementTargetResolution.Resolved
        assertTrue(resolved.itemIndex > 0)
        assertTrue(resolved.localCharacterOffset >= 0)
    }

    @Test fun `unresolved targets retain concrete reason`() {
        val snapshot = snapshot()
        assertEquals("target paragraph missing", (resolveMovementTarget(snapshot, manuscriptChunks(snapshot), movement(1, paragraph = 4)) as MovementTargetResolution.Unresolved).reason)
        assertEquals("stale manuscript revision", (resolveMovementTarget(snapshot, manuscriptChunks(snapshot), movement(1, manuscriptRevision = 1)) as MovementTargetResolution.Unresolved).reason)
    }

    @Test fun `tablet manual hold does not expire back to the old authoritative target`() {
        val controller = MovementFollowController()
        assertFalse(controller.isManualHoldActive())
        // Programmatic animation never calls recordUserTouch.
        assertEquals(ManualMovementDecision.Apply, controller.evaluateMovement(movement(0)))
        controller.recordUserTouch()
        controller.recordScrollObserved()
        controller.recordVisibleAnchor(anchor(400))

        assertTrue(controller.isManualHoldActive())
        assertTrue(controller.evaluateMovement(movement(0, tokenIndex = 20)) is ManualMovementDecision.Suppress)
        assertTrue(controller.isManualHoldActive())
    }

    @Test fun `explicit nearby coordinator reacquire releases tablet manual hold`() {
        val controller = MovementFollowController()
        controller.recordUserTouch()
        controller.recordScrollObserved()
        controller.recordVisibleAnchor(anchor(400))
        controller.recordCoordinatorResult(true, 400)

        assertTrue(
            controller.evaluateMovement(
                movement(
                    400,
                    tokenIndex = 405,
                    classification = "manual scroll reacquired",
                    manualStatus = "reacquired",
                    manualAnchor = 400,
                    manualDistance = 5
                )
            ) is ManualMovementDecision.Resume
        )
        assertFalse(controller.isManualHoldActive())
        assertEquals(TabletManualOverrideState.FOLLOWING, controller.manualOverrideState())
    }

    @Test fun `nearby authoritative target releases without manual status fields`() {
        val controller = MovementFollowController()
        controller.recordUserTouch()
        controller.recordScrollObserved()
        controller.recordVisibleAnchor(anchor(121, paragraph = 10, sentence = 20))

        assertTrue(
            controller.evaluateMovement(
                movement(860, paragraph = 10, sentence = 22, tokenIndex = 144, classification = "suspicious forward jump")
            ) is ManualMovementDecision.Resume
        )
        assertFalse(controller.isManualHoldActive())
    }

    @Test fun `wrong section evidence enters rejected hold and old position stays suppressed`() {
        val controller = MovementFollowController()
        controller.recordUserTouch()
        controller.recordScrollObserved()
        controller.recordVisibleAnchor(anchor(400))
        controller.recordCoordinatorResult(true, 400)

        assertTrue(
            controller.evaluateMovement(
                movement(20, tokenIndex = 20, manualStatus = "holding", manualAnchor = 400, manualDistance = -380)
            ) is ManualMovementDecision.Suppress
        )
        assertEquals(TabletManualOverrideState.REJECTED_HOLD, controller.manualOverrideState())
        assertTrue(controller.evaluateMovement(movement(20, tokenIndex = 20)) is ManualMovementDecision.Suppress)
    }

    @Test fun `second swipe replaces pending anchor and stale confirmation cannot release it`() {
        val controller = MovementFollowController()
        controller.recordUserTouch()
        controller.recordScrollObserved()
        controller.recordVisibleAnchor(anchor(400))
        assertTrue(controller.recordUserTouch())
        controller.recordScrollObserved()
        controller.recordVisibleAnchor(anchor(700))

        assertFalse(controller.recordCoordinatorResult(true, 400))
        assertTrue(
            controller.evaluateMovement(
                movement(405, tokenIndex = 405, manualStatus = "reacquired", manualAnchor = 400)
            ) is ManualMovementDecision.Suppress
        )
        assertTrue(controller.recordCoordinatorResult(true, 700))
        assertTrue(
            controller.evaluateMovement(
                movement(705, tokenIndex = 705, manualStatus = "reacquired", manualAnchor = 700)
            ) is ManualMovementDecision.Resume
        )
    }

    @Test fun `returning to original section can reacquire the replacement anchor`() {
        val controller = MovementFollowController()
        controller.recordUserTouch()
        controller.recordScrollObserved()
        controller.recordVisibleAnchor(anchor(20))
        controller.recordCoordinatorResult(true, 20)

        assertTrue(
            controller.evaluateMovement(
                movement(18, tokenIndex = 18, manualStatus = "reacquired", manualAnchor = 20, manualDistance = -2)
            ) is ManualMovementDecision.Resume
        )
    }

    @Test fun `logged tablet sequence suppresses old target then resumes nearby and continues normally`() {
        val controller = MovementFollowController()
        controller.recordUserTouch()
        controller.recordScrollObserved()
        controller.recordVisibleAnchor(anchor(121, paragraph = 10, sentence = 20))

        assertTrue(controller.evaluateMovement(movement(80, paragraph = 2, sentence = 4, tokenIndex = 12)) is ManualMovementDecision.Suppress)
        assertTrue(controller.evaluateMovement(movement(860, paragraph = 10, sentence = 22, tokenIndex = 144, classification = "suspicious forward jump")) is ManualMovementDecision.Resume)
        assertEquals(ManualMovementDecision.Apply, controller.evaluateMovement(movement(890, paragraph = 10, sentence = 23, tokenIndex = 149, classification = "small local correction")))
        assertEquals(ManualMovementDecision.Apply, controller.evaluateMovement(movement(940, paragraph = 11, sentence = 24, tokenIndex = 157)))
    }

    @Test fun `anchor 84 reacquires target 144 inside local tolerance`() {
        val controller = MovementFollowController()
        controller.recordUserTouch()
        controller.recordScrollObserved()
        controller.recordVisibleAnchor(anchor(84, paragraph = 10, sentence = 20))
        assertTrue(controller.evaluateMovement(movement(860, paragraph = 10, sentence = 22, tokenIndex = 144)) is ManualMovementDecision.Resume)
    }

    @Test fun `anchor 8 does not reacquire far target 157`() {
        val controller = MovementFollowController()
        controller.recordUserTouch()
        controller.recordScrollObserved()
        controller.recordVisibleAnchor(anchor(8))
        assertTrue(controller.evaluateMovement(movement(157, tokenIndex = 157)) is ManualMovementDecision.Suppress)
        assertTrue(controller.isManualHoldActive())
    }

    @Test fun `logged anchor 48 paragraph 10 suppresses old token 16 paragraph 4 then resumes locally`() {
        val controller = MovementFollowController()
        controller.recordUserTouch()
        controller.recordScrollObserved()
        controller.recordVisibleAnchor(anchor(48, paragraph = 10, sentence = 20, character = 480))

        assertTrue(
            controller.evaluateMovement(
                movement(160, paragraph = 4, sentence = 8, tokenIndex = 16)
            ) is ManualMovementDecision.Suppress
        )
        assertTrue(controller.isManualHoldActive())
        assertTrue(
            controller.evaluateMovement(
                movement(500, paragraph = 10, sentence = 21, tokenIndex = 52)
            ) is ManualMovementDecision.Resume
        )
        assertFalse(controller.isManualHoldActive())
    }

    @Test fun `logged anchor 58 paragraph 10 suppresses old token 16 paragraph 4`() {
        val controller = MovementFollowController()
        controller.recordUserTouch()
        controller.recordScrollObserved()
        controller.recordVisibleAnchor(anchor(58, paragraph = 10, sentence = 22, character = 580))

        assertTrue(
            controller.evaluateMovement(
                movement(160, paragraph = 4, sentence = 8, tokenIndex = 16)
            ) is ManualMovementDecision.Suppress
        )
        assertTrue(controller.isManualHoldActive())
    }

    @Test fun `tap without scroll releases the tentative override`() {
        val controller = MovementFollowController()
        controller.recordUserTouch()
        assertTrue(controller.cancelTouchWithoutScroll())
        assertFalse(controller.isManualHoldActive())
    }

    @Test fun `definitive anchor send failure clears hold instead of wedging silently`() {
        val controller = MovementFollowController()
        controller.recordUserTouch()
        controller.recordScrollObserved()
        controller.recordVisibleAnchor(anchor(48, paragraph = 10))

        assertTrue(controller.recordAnchorSendFailure(48))
        assertFalse(controller.isManualHoldActive())
        assertEquals(TabletManualOverrideState.FOLLOWING, controller.manualOverrideState())
    }

    @Test fun `stale send failure cannot clear a replacement swipe anchor`() {
        val controller = MovementFollowController()
        controller.recordUserTouch()
        controller.recordScrollObserved()
        controller.recordVisibleAnchor(anchor(48, paragraph = 10))
        controller.recordUserTouch()
        controller.recordScrollObserved()
        controller.recordVisibleAnchor(anchor(58, paragraph = 10))

        assertFalse(controller.recordAnchorSendFailure(48))
        assertTrue(controller.isManualHoldActive())
    }

    @Test fun `reading band chooses the closest visible tablet anchor`() {
        val chosen = nearestTabletVisibleAnchor(listOf(
            TabletVisibleAnchor(10, 50, 1, 0, -80f),
            TabletVisibleAnchor(20, 100, 2, 1, 6f),
            TabletVisibleAnchor(30, 150, 3, 2, 55f)
        ))
        assertEquals(20, chosen?.tokenIndex)
    }

    @Test fun `repeated manual scroll and reacquire cycles retain only current bounded state`() {
        val controller = MovementFollowController()
        repeat(10_000) { cycle ->
            val token = 100 + cycle
            val paragraph = cycle % 20
            val sentence = paragraph * 2
            controller.recordUserTouch()
            controller.recordScrollObserved()
            controller.recordVisibleAnchor(anchor(token, paragraph, sentence, token * 6))
            controller.recordCoordinatorResult(true, token)
            assertTrue(
                controller.evaluateMovement(
                    movement(
                        character = token * 6,
                        paragraph = paragraph,
                        sentence = sentence,
                        tokenIndex = token,
                        manualStatus = "reacquired",
                        manualAnchor = token,
                        manualDistance = 0
                    )
                ) is ManualMovementDecision.Resume
            )
        }
        assertFalse(controller.isManualHoldActive())
        assertEquals(TabletManualOverrideState.FOLLOWING, controller.manualOverrideState())
    }
}
