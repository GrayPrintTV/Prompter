package app.prompter.tablet.ui.prompter

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.PointerType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.prompter.tablet.connection.ConnectionState
import app.prompter.tablet.ui.MainUiState
import app.prompter.tablet.ui.MainViewModel
import app.prompter.tablet.ui.Screen
import kotlinx.coroutines.delay
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import androidx.compose.runtime.withFrameNanos
import kotlin.math.roundToInt
import kotlin.math.max
import kotlin.math.abs
import kotlin.math.min
import app.prompter.tablet.protocol.RuntimeFollowSettings
import app.prompter.tablet.settings.effectiveDisplaySettings

internal fun tabletNarrationStatus(
    connected: Boolean,
    reconnecting: Boolean,
    controllerReady: Boolean,
    streamRegistered: Boolean,
    audioActive: Boolean,
    microphonePreparing: Boolean
) = when {
    connected && audioActive -> "Following narration"
    connected && microphonePreparing -> "Preparing microphone"
    connected && streamRegistered -> "Microphone ready"
    connected && controllerReady -> "Ready to start"
    connected -> "Connected — microphone stopped"
    reconnecting -> "Reconnecting…"
    else -> "Disconnected"
}

internal fun manualFollowProductStatus(overrideState: String): String? = when (overrideState) {
    "normal" -> null
    "user scrolling" -> "Repositioning…"
    "anchor selected", "anchor sent", "waiting for reacquire" -> "Finding your place…"
    "holding wrong-section" -> "Holding at your chosen position"
    "reacquired/resumed" -> "Following resumed"
    "anchor queued during reconnect" -> "Position saved; waiting for control"
    "anchor send failed" -> "Could not send the new position"
    else -> "Manual position active"
}

@Composable
internal fun PrompterScreen(state: MainUiState, viewModel: MainViewModel, viewport: ReaderViewportState?, requestMicrophone: () -> Unit) {
    val snapshot = state.session.snapshot
    if (snapshot == null) { LaunchedEffect(Unit) { viewModel.show(Screen.CONNECTION) }; return }
    val readerViewport = requireNotNull(viewport)
    val chunks = remember(snapshot.manuscript.contentHash) { manuscriptChunks(snapshot) }
    val paragraphs = remember(snapshot.manuscript.contentHash) { visualParagraphs(snapshot, chunks) }
    val navigationIndex = remember(snapshot.manuscript.contentHash) {
        ManuscriptNavigationIndex.build(paragraphs, snapshot.manuscript.normalizedContent?.length ?: 0)
    }
    val listState = readerViewport.listState
    val fastScrollScope = rememberCoroutineScope()
    val fastScrollJob = remember { arrayOfNulls<Job>(1) }
    val followController = readerViewport.followController
    val assistCruise = remember { AssistCruiseController() }
    val runtime = state.session.runtimeSettings
    val runtimeDisplay = runtime?.display
    val runtimeFollow = runtime?.follow
    val paragraphLayouts = remember { mutableStateMapOf<String, TextLayoutResult>() }
    val movement = state.session.latestMovement
    val manualRepositionResult = state.session.manualRepositionResult
    val snapshotAnchor = state.session.snapshotAnchor
    val anchorTarget = snapshotAnchor?.takeIf { !it.consumed }?.let { anchor -> app.prompter.tablet.protocol.MovementEvent(
        snapshot.sessionRevision, snapshot.manuscriptRevision, anchor.tokenIndex, anchor.tokenIndex,
        anchor.character, anchor.sentenceIndex, anchor.paragraphIndex, snapshot.currentConfidence, 350,
        "snapshot-anchor", "One-shot snapshot anchor"
    ) }
    val effectiveTarget = movement ?: anchorTarget
    val effectiveTargetParagraph = effectiveTarget?.paragraphIndex ?: -1
    val effectiveTargetCharacter = effectiveTarget?.targetCharacter ?: -1
    val effectiveDisplay = effectiveDisplaySettings(runtimeDisplay, state.display)
    val density = LocalDensity.current
    val fontSizeSp = effectiveDisplay.fontSizeSp
    val lineSpacing = effectiveDisplay.lineSpacing
    val lineHeightPx = with(density) { (fontSizeSp * lineSpacing).sp.toPx() }
    val targetLayout = paragraphs.firstOrNull { it.paragraphIndex == effectiveTargetParagraph }?.let { paragraphLayouts[it.key] }
    LaunchedEffect(effectiveDisplay.layoutKey, readerViewport.viewportHeight, readerViewport.viewportWidth, snapshot.manuscript.contentHash) {
        if (readerViewport.viewportHeight > 0 && readerViewport.viewportWidth > 0) {
            assistCruise.reset(clearPace = true)
            viewModel.logAssistCruiseReset("layout or viewport changed")
        }
        viewModel.logRelayoutStarted(runtime?.settingsRevision, effectiveTarget?.targetCharacter, effectiveDisplay.layoutKey)
    }
    LaunchedEffect(readerViewport.manualTouchGeneration) {
        if (readerViewport.manualTouchGeneration <= 0 || !followController.isManualHoldActive()) return@LaunchedEffect
        delay(850)
        if (
            !readerViewport.manualScrollObserved &&
            !listState.isScrollInProgress &&
            followController.cancelTouchWithoutScroll()
        ) {
            viewModel.logManualTouchWithoutScroll()
            readerViewport.manualTouchGeneration += 1
        }
    }
    LaunchedEffect(listState.isScrollInProgress, readerViewport.fastScrollDragging, readerViewport.manualTouchGeneration) {
        if (readerViewport.manualTouchGeneration <= 0 || !followController.isManualHoldActive()) return@LaunchedEffect
        if (listState.isScrollInProgress || readerViewport.fastScrollDragging) {
            if (readerViewport.fastScrollDragging) return@LaunchedEffect
            followController.recordScrollObserved()
            if (!readerViewport.manualScrollObserved) viewModel.logTabletScrollObserved()
            readerViewport.manualScrollObserved = true
            return@LaunchedEffect
        }
        if (!readerViewport.manualScrollObserved || readerViewport.viewportHeight <= 0) return@LaunchedEffect
        delay(180)
        if (listState.isScrollInProgress || readerViewport.fastScrollDragging) return@LaunchedEffect
        viewModel.logTabletMomentumSettled()
        val layoutInfo = listState.layoutInfo
        val readingBandY = (readerViewport.viewportHeight * effectiveDisplay.readingBandFraction).roundToInt()
        val candidates = layoutInfo.visibleItemsInfo.flatMap { item ->
            val paragraph = paragraphs.getOrNull(item.index) ?: return@flatMap emptyList()
            val layout = paragraphLayouts[paragraph.key] ?: return@flatMap emptyList()
            (0 until layout.lineCount).mapNotNull { line ->
                val localCharacter = layout.getLineStart(line)
                val manuscriptCharacter = paragraph.characterStart + localCharacter
                val token = snapshot.manuscript.tokens.minByOrNull {
                    abs(it.characterRange.start - manuscriptCharacter)
                } ?: return@mapNotNull null
                val lineCenter = item.offset - layoutInfo.viewportStartOffset +
                    (layout.getLineTop(line) + layout.getLineBottom(line)) / 2f
                TabletVisibleAnchor(
                    tokenIndex = token.tokenIndex,
                    character = token.characterRange.start,
                    sentenceIndex = token.sentenceIndex,
                    paragraphIndex = token.paragraphIndex,
                    distanceFromReadingBandPx = lineCenter - readingBandY
                )
            }
        }
        val anchor = nearestTabletVisibleAnchor(candidates)
        if (anchor == null) {
            viewModel.logMovementGeometryRetry("tablet manual visible anchor unavailable")
            return@LaunchedEffect
        }
        val direction = when {
            anchor.tokenIndex < snapshot.acceptedPosition.tokenIndex -> "backward"
            anchor.tokenIndex > snapshot.acceptedPosition.tokenIndex -> "forward"
            else -> "stationary"
        }
        followController.recordVisibleAnchor(anchor)
        viewModel.logTabletVisibleAnchorSelected(anchor, direction)
        val sendOutcome = viewModel.sendTabletManualReposition(
            anchor,
            snapshot.manuscriptRevision,
            direction,
            readerViewport.manualInputSource,
            readerViewport.manualDetectedAtMs
        )
        if (
            sendOutcome is app.prompter.tablet.connection.ManualRepositionSendOutcome.Failed &&
            followController.recordAnchorSendFailure(anchor.tokenIndex)
        ) {
            viewModel.logTabletManualOverrideCleared("manual anchor send failed: ${sendOutcome.reason}")
        }
        readerViewport.manualScrollObserved = false
    }
    LaunchedEffect(
        manualRepositionResult?.accepted,
        manualRepositionResult?.visibleTokenIndex,
        manualRepositionResult?.sessionRevision
    ) {
        val result = manualRepositionResult ?: return@LaunchedEffect
        if (followController.recordCoordinatorResult(result.accepted, result.visibleTokenIndex)) {
            viewModel.logTabletManualCoordinatorResult(result, followController.manualOverrideState())
            readerViewport.manualTouchGeneration += 1
        }
    }
    LaunchedEffect(movement?.targetTokenIndex, movement?.targetCharacter, movement?.sessionRevision, movement?.manuscriptRevision, movement?.classification, movement?.confidence, movement?.manualRepositionStatus, movement?.manualAnchorTokenIndex, snapshotAnchor?.identity, snapshotAnchor?.consumed, effectiveTargetCharacter, state.connection, state.connectionDiagnostics.controllerLease, state.audio.active, runtimeFollow, readerViewport.manualTouchGeneration, effectiveDisplay.layoutKey, readerViewport.viewportHeight, readerViewport.viewportWidth, targetLayout) {
        if (readerViewport.viewportHeight <= 0) { viewModel.logMovementGeometryRetry("viewport unavailable"); return@LaunchedEffect }
        val target = effectiveTarget ?: return@LaunchedEffect
        val renderedKey = movement?.let {
            RenderedMovementKey(state.session.sessionId, state.session.latestMovementEventId, it, effectiveDisplay.layoutKey, readerViewport.viewportWidth, readerViewport.viewportHeight)
        }
        if (renderedKey != null && readerViewport.renderedMovement == renderedKey) return@LaunchedEffect
        val applyingAnchor = movement == null && snapshotAnchor != null && !snapshotAnchor.consumed
        if (movement == null && snapshotAnchor?.consumed == true) { viewModel.logSnapshotAnchorIgnored(snapshotAnchor.identity); return@LaunchedEffect }
        if (state.connection !is ConnectionState.Connected || !state.connectionDiagnostics.controllerLease) {
            assistCruise.reset()
            val reason = if (state.connection !is ConnectionState.Connected) {
                "connection ${state.connection::class.simpleName ?: "not active"}"
            } else {
                "waiting for controller lease (${state.connectionDiagnostics.controllerLeaseState})"
            }
            viewModel.logAssistCruiseReset(reason)
            viewModel.logMovementWaitingForConnectionOrLease(reason, target)
            return@LaunchedEffect
        }
        when (val manualDecision = followController.evaluateMovement(target)) {
            ManualMovementDecision.Apply -> Unit
            is ManualMovementDecision.Suppress -> {
                assistCruise.reset()
                viewModel.logRemoteMovementSuppressed(target, manualDecision.reason)
                return@LaunchedEffect
            }
            is ManualMovementDecision.Resume -> {
                viewModel.logTabletAutoFollowResumed(target, manualDecision.reason)
            }
        }
        when (val resolution = resolveMovementTarget(snapshot, chunks, target)) {
            is MovementTargetResolution.Unresolved -> viewModel.logMovementUnresolved(resolution.reason, target)
            is MovementTargetResolution.Resolved -> {
                val paragraphItemIndex = paragraphs.indexOfFirst { it.paragraphIndex == target.paragraphIndex }
                if (paragraphItemIndex < 0) { viewModel.logMovementUnresolved("target paragraph missing", target); return@LaunchedEffect }
                val visualParagraph = paragraphs[paragraphItemIndex]
                val localCharacterOffset = (target.targetCharacter - visualParagraph.characterStart).coerceIn(0, visualParagraph.text.length)
                viewModel.logMovementTargetResolved(target, paragraphItemIndex, localCharacterOffset)
                val visible = listState.layoutInfo.visibleItemsInfo.firstOrNull { it.index == paragraphItemIndex }
                if (visible == null) {
                    // One internal positioning jump is permitted only when the target is outside the composed window.
                    listState.scrollToItem(paragraphItemIndex)
                    withFrameNanos { }
                }
                val item = listState.layoutInfo.visibleItemsInfo.firstOrNull { it.index == paragraphItemIndex }
                    ?: run { viewModel.logMovementUnresolved("item lookup failure", target); return@LaunchedEffect }
                val bandY = ((readerViewport.viewportHeight.takeIf { it > 0 } ?: listState.layoutInfo.viewportEndOffset) * effectiveDisplay.readingBandFraction).roundToInt()
                val layout = paragraphLayouts[visualParagraph.key]
                    ?: run { viewModel.logMovementGeometryRetry("paragraph text layout unavailable; retry scheduled"); return@LaunchedEffect }
                val lineIndex = layout.getLineForOffset(localCharacterOffset.coerceAtMost((visualParagraph.text.length - 1).coerceAtLeast(0)))
                val localLineY = (layout.getLineTop(lineIndex) + layout.getLineBottom(lineIndex)) / 2f
                val layoutInfo = listState.layoutInfo
                val geometry = ViewportTargetGeometry(
                    itemOffset = item.offset,
                    viewportStartOffset = layoutInfo.viewportStartOffset,
                    beforeContentPadding = layoutInfo.beforeContentPadding,
                    lineCenterInsideParagraph = localLineY,
                    readingBandCenter = bandY
                )
                val distance = geometry.desiredScrollDelta
                viewModel.logMovementLinePosition(target, visualParagraph.paragraphIndex, lineIndex, geometry, layoutInfo.viewportEndOffset, item.size, listState.firstVisibleItemIndex, listState.firstVisibleItemScrollOffset)
                val follow = runtimeFollow ?: RuntimeFollowSettings(true, .45f, 840f, .45f, 18f, "animate")
                val plan = planSmoothFollow(distance, target.durationHintMs, follow)
                try {
                    if (plan.shouldAnimate) {
                        // Routine corrections should reconcile promptly so visual cruising owns the
                        // gap between semantic updates. Resynchronization keeps its conservative plan.
                        val duration = if (plan.policy == "resync") plan.durationMs else min(plan.durationMs, 650)
                        val started = System.currentTimeMillis()
                        viewModel.logMovementAnimationStarted(target, paragraphItemIndex, plan.policy, duration, distance, bandY)
                        var previous = 0f
                        animate(0f, distance, animationSpec = tween(duration, easing = LinearOutSlowInEasing)) { value, _ ->
                            listState.dispatchRawDelta(value - previous)
                            previous = value
                        }
                        viewModel.logMovementAnimationCompleted(target, paragraphItemIndex, plan.policy, System.currentTimeMillis() - started, distance)
                    } else {
                        viewModel.logMovementAnimationCompleted(target, paragraphItemIndex, plan.policy, 0, distance)
                    }
                    viewModel.logRelayoutAlignmentCompleted(target.targetCharacter)
                    if (renderedKey != null) readerViewport.renderedMovement = renderedKey
                    if (applyingAnchor) {
                        assistCruise.reset(clearPace = true)
                        viewModel.logAssistCruiseReset("new snapshot anchor")
                        viewModel.logSnapshotAnchorApplied(snapshotAnchor.identity)
                        servicesConsumeAnchor(viewModel, snapshotAnchor.identity)
                        return@LaunchedEffect
                    }

                    // The server remains the only semantic authority. This controller only emits
                    // small visual deltas after a reliable Windows anchor has been rendered.
                    val receivedAtMs = System.currentTimeMillis()
                    val paceSample = assistCruise.acceptAnchor(
                        AssistCruiseAnchor(target.targetTokenIndex, receivedAtMs, target.confidence, target.classification),
                        lineHeightPx,
                        allowPaceSample = !followController.isManualHoldActive()
                    )
                    viewModel.logAssistAnchor(target, receivedAtMs, lineHeightPx, paceSample)
                    viewModel.logAssistCruiseStarted(target, distance)
                    var previousFrameMs = receivedAtMs
                    var lastFrameDiagnosticMs = receivedAtMs
                    while (true) {
                        val nowMs = withFrameNanos { it / 1_000_000L }
                        val gateReason = when {
                            !state.connectionDiagnostics.controllerLease -> "controller lease mismatch"
                            !state.audio.active -> "microphone paused or stopped"
                            followController.isManualHoldActive() -> "manual-scroll hold active"
                            else -> null
                        }
                        val frame = assistCruise.nextFrame(nowMs, nowMs - previousFrameMs, lineHeightPx, follow.enabled, gateReason)
                        previousFrameMs = nowMs
                        if (frame.stopped) {
                            viewModel.logAssistCruiseStopped(frame.reason, frame.staleAgeMs)
                            if (frame.reason == "authoritative anchor stale") {
                                // Cruise is bounded, so the target stays composed. Recompute the
                                // viewport error and settle exactly on the last Windows anchor.
                                val finalItem = listState.layoutInfo.visibleItemsInfo.firstOrNull { it.index == paragraphItemIndex }
                                if (finalItem != null) {
                                    val finalInfo = listState.layoutInfo
                                    val finalGeometry = ViewportTargetGeometry(finalItem.offset, finalInfo.viewportStartOffset, finalInfo.beforeContentPadding, localLineY, bandY)
                                    val finalDistance = finalGeometry.desiredScrollDelta
                                    if (abs(finalDistance) > follow.deadZoneDp) {
                                        var finalPrevious = 0f
                                        animate(0f, finalDistance, animationSpec = tween(320, easing = LinearOutSlowInEasing)) { value, _ ->
                                            listState.dispatchRawDelta(value - finalPrevious)
                                            finalPrevious = value
                                        }
                                    }
                                    viewModel.logAssistCruiseSettled(target, finalDistance)
                                }
                            }
                            return@LaunchedEffect
                        }
                        if (frame.deltaPx > 0f) listState.dispatchRawDelta(frame.deltaPx)
                        if (nowMs - lastFrameDiagnosticMs >= 5_000) {
                            viewModel.logAssistCruiseFrame(frame)
                            lastFrameDiagnosticMs = nowMs
                        }
                    }
                } catch (cancelled: CancellationException) {
                    viewModel.logMovementAnimationCancelled(target, paragraphItemIndex, "retargeted by newer movement")
                    viewModel.logAssistCruiseSuperseded(target, "newer semantic target, layout, or manual hold")
                    throw cancelled
                }
            }
        }
    }

    val background = runtimeDisplay?.backgroundColor?.toComposeColor()
        ?: if (state.display.darkTheme) Color(0xFF2C202C) else Color(0xFFFFF7F2)
    val text = runtimeDisplay?.textColor?.toComposeColor()
        ?: if (state.display.darkTheme) Color(0xFFF6EDF0) else Color(0xFF641A34)
    val highlight = runtimeDisplay?.highlightColor?.toComposeColor() ?: Color(0xFFE2CF9E)
    val opacity = runtimeDisplay?.highlightOpacity ?: 0f
    val bandHeightPx = lineHeightPx * effectiveDisplay.readingBandHeightLines
    val paragraphSpacing = with(density) { (fontSizeSp * effectiveDisplay.paragraphSpacingEm).sp.toDp() }
    val bandFraction = effectiveDisplay.readingBandFraction
    val bandY = (bandFraction * readerViewport.viewportHeight).roundToInt()
    val topContentPaddingPx = max(0, bandY - (lineHeightPx / 2).roundToInt())
    val bottomContentPaddingPx = max(0, readerViewport.viewportHeight - bandY - (lineHeightPx / 2).roundToInt())
    val sideMargins = with(density) {
        ((readerViewport.viewportWidth * (1f - effectiveDisplay.contentWidthFraction) / 2f).roundToInt()).toDp()
    }
    val manuscriptLength = snapshot.manuscript.normalizedContent?.length ?: 0
    Box(Modifier.fillMaxSize().background(background).onSizeChanged { readerViewport.viewportHeight = it.height; readerViewport.viewportWidth = it.width }) {
        LazyColumn(
            state = listState,
            contentPadding = PaddingValues(top = with(density) { topContentPaddingPx.toDp() }, bottom = with(density) { bottomContentPaddingPx.toDp() }, start = sideMargins, end = sideMargins),
            modifier = Modifier.fillMaxSize().pointerInput(Unit) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    readerViewport.manualDetectedAtMs = System.currentTimeMillis()
                    readerViewport.manualInputSource = if (down.type == PointerType.Touch) "touch" else "pointer"
                      val replaced = followController.recordUserTouch()
                      viewModel.logManualScrollStarted(readerViewport.manualInputSource, "prompter-lazy-column")
                      if (replaced) viewModel.logTabletManualOverrideReplaced()
                      readerViewport.manualTouchGeneration += 1
                }
            }
        ) {
            itemsIndexed(paragraphs, key = { _, paragraph -> paragraph.key }) { _, paragraph ->
                Text(
                    paragraph.text,
                    fontSize = fontSizeSp.sp,
                    lineHeight = (fontSizeSp * lineSpacing).sp,
                    textAlign = TextAlign.Start,
                    color = text,
                    onTextLayout = { paragraphLayouts[paragraph.key] = it },
                    modifier = Modifier.fillMaxWidth().padding(bottom = paragraphSpacing)
                )
            }
        }
        Box(Modifier.fillMaxWidth().height(with(density) { bandHeightPx.toDp() }).align(Alignment.TopCenter).offset { IntOffset(0, bandY - (bandHeightPx / 2).roundToInt()) }
            .background(highlight.copy(alpha = opacity)).drawBehind {
                val edgeColor = highlight.copy(alpha = .72f)
                drawLine(edgeColor, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx())
                drawLine(edgeColor, Offset(0f, size.height), Offset(size.width, size.height), 1.dp.toPx())
            })
        ManuscriptFastScrollThumb(
            listState = listState,
            paragraphs = paragraphs,
            manuscriptLength = manuscriptLength,
            navigationIndex = navigationIndex,
            dragging = readerViewport.fastScrollDragging,
            color = text,
            onDragStart = {
                readerViewport.manualDetectedAtMs = System.currentTimeMillis()
                readerViewport.manualInputSource = "fast-scroll"
                readerViewport.manualScrollObserved = false
                readerViewport.fastScrollDragging = true
                val replaced = followController.recordUserTouch()
                viewModel.logManualScrollStarted(readerViewport.manualInputSource, "prompter-lazy-column")
                if (replaced) viewModel.logTabletManualOverrideReplaced()
                readerViewport.manualTouchGeneration += 1
            },
            onFractionChanged = { fraction ->
                if (!readerViewport.manualScrollObserved) viewModel.logTabletScrollObserved()
                readerViewport.manualScrollObserved = true
                followController.recordScrollObserved()
                fastScrollJob[0]?.cancel()
                fastScrollJob[0] = fastScrollScope.launch {
                    fastScrollTargetForFraction(fraction, paragraphs, manuscriptLength)?.let { target ->
                        listState.scrollToItem(target.itemIndex)
                        withFrameNanos { }
                        val paragraph = paragraphs[target.itemIndex]
                        val layout = paragraphLayouts[paragraph.key]
                        val item = listState.layoutInfo.visibleItemsInfo.firstOrNull { it.index == target.itemIndex }
                        if (layout != null && item != null) {
                            val safeOffset = target.localCharacterOffset.coerceAtMost((paragraph.text.length - 1).coerceAtLeast(0))
                            val line = layout.getLineForOffset(safeOffset)
                            val lineCenter = (layout.getLineTop(line) + layout.getLineBottom(line)) / 2f
                            val layoutInfo = listState.layoutInfo
                            val geometry = ViewportTargetGeometry(
                                itemOffset = item.offset,
                                viewportStartOffset = layoutInfo.viewportStartOffset,
                                beforeContentPadding = layoutInfo.beforeContentPadding,
                                lineCenterInsideParagraph = lineCenter,
                                readingBandCenter = bandY
                            )
                            listState.dispatchRawDelta(geometry.desiredScrollDelta)
                        }
                    }
                }
            },
            onDragEnd = {
                val finalJump = fastScrollJob[0]
                fastScrollScope.launch {
                    finalJump?.join()
                    readerViewport.fastScrollDragging = false
                    readerViewport.manualTouchGeneration += 1
                }
            },
            modifier = Modifier
                .align(Alignment.CenterEnd)
                .fillMaxHeight()
                .padding(top = 72.dp, bottom = 96.dp)
        )
        Surface(Modifier.align(Alignment.TopCenter).fillMaxWidth(), tonalElevation = 4.dp) {
            Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    AssistChip(onClick = viewModel::reconnect, label = {
                        Text(tabletNarrationStatus(
                            connected = state.connection is ConnectionState.Connected,
                            reconnecting = state.connection is ConnectionState.Reconnecting,
                            controllerReady = state.connectionDiagnostics.controllerLease,
                            streamRegistered = state.connectionDiagnostics.registeredAudioStreamId != null,
                            audioActive = state.audio.active,
                            microphonePreparing = state.microphonePreparing
                        ))
                    })
                    Spacer(Modifier.weight(1f))
                    IconButton(onClick = { viewModel.show(Screen.SETTINGS) }) { Icon(Icons.Default.Settings, "Display settings") }
                    IconButton(onClick = { viewModel.show(Screen.DIAGNOSTICS) }) { Icon(Icons.Default.Info, "Diagnostics") }
                }
                manualFollowProductStatus(state.manualFollow.overrideState)?.let {
                    Text(it, maxLines = 1, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                }
                state.session.latestTranscript?.takeIf { it.isNotBlank() }?.let {
                    Text("Heard: $it", maxLines = 1, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        ExtendedFloatingActionButton(
            onClick = { if (state.audio.active) viewModel.stopMicrophone() else requestMicrophone() },
            icon = { Icon(if (state.audio.active) Icons.Default.MicOff else Icons.Default.Mic, null) },
            text = { Text(if (state.audio.active) "Pause narration" else "Start narration") },
            containerColor = if (state.audio.active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.secondaryContainer,
            modifier = Modifier.align(Alignment.BottomCenter).padding(24.dp)
        )
        if (state.microphonePermissionDenied) Text("Microphone permission denied", color = MaterialTheme.colorScheme.error, modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 96.dp))
        if (state.connectionDiagnostics.controllerLeaseState == app.prompter.tablet.connection.ControllerLeaseState.STREAM_REGISTRATION_FAILED) {
            Text(
                state.connectionDiagnostics.lastError ?: "Microphone stream registration failed. Tap Start microphone to retry.",
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.align(Alignment.BottomCenter).padding(horizontal = 24.dp, vertical = 96.dp)
            )
        }
    }
}

private fun servicesConsumeAnchor(viewModel: MainViewModel, identity: String) = viewModel.consumeSnapshotAnchor(identity)

private fun String.toComposeColor(): Color = runCatching { Color(android.graphics.Color.parseColor(this)) }.getOrElse { Color.Unspecified }
