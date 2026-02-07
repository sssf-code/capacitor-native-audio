package ssf.capacitorjs.plugins.nativeaudio;

import android.os.Bundle;
import androidx.annotation.OptIn;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.session.MediaSession;
import androidx.media3.session.SessionCommand;
import androidx.media3.session.SessionCommands;
import androidx.media3.session.SessionResult;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;
import org.json.JSONObject;

public class MediaSessionCallback implements MediaSession.Callback {
    private final QueuePlayer queuePlayer;

    public MediaSessionCallback(QueuePlayer queuePlayer) {
        this.queuePlayer = queuePlayer;
    }

    @OptIn(markerClass = UnstableApi.class)
    @Override
    public MediaSession.ConnectionResult onConnect(
        MediaSession session,
        MediaSession.ControllerInfo controller
    ) {
        SessionCommands sessionCommands = MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS
            .buildUpon()
            .add(new SessionCommand(QueuePlayer.CMD_SET_QUEUE, Bundle.EMPTY))
            .add(new SessionCommand(QueuePlayer.CMD_SYNC_QUEUE, Bundle.EMPTY))
            .add(new SessionCommand(QueuePlayer.CMD_GET_QUEUE, Bundle.EMPTY))
            .add(new SessionCommand(QueuePlayer.CMD_ADD_ITEMS, Bundle.EMPTY))
            .add(new SessionCommand(QueuePlayer.CMD_REMOVE_ITEM, Bundle.EMPTY))
            .add(new SessionCommand(QueuePlayer.CMD_MOVE_ITEM, Bundle.EMPTY))
            .add(new SessionCommand(QueuePlayer.CMD_CLEAR_QUEUE, Bundle.EMPTY))
            .add(new SessionCommand(QueuePlayer.CMD_GET_STATE, Bundle.EMPTY))
            .add(new SessionCommand(QueuePlayer.CMD_SET_PROGRESS, Bundle.EMPTY))
            .add(new SessionCommand(QueuePlayer.CMD_GET_PROGRESS, Bundle.EMPTY))
            .add(new SessionCommand(QueuePlayer.CMD_SET_OPTIONS, Bundle.EMPTY))
            .add(new SessionCommand(QueuePlayer.CMD_GET_OPTIONS, Bundle.EMPTY))
            .add(new SessionCommand(QueuePlayer.CMD_SET_VOLUME, Bundle.EMPTY))
            .add(new SessionCommand(QueuePlayer.CMD_SET_RATE, Bundle.EMPTY))
            .add(new SessionCommand(QueuePlayer.CMD_SET_REPEAT_MODE, Bundle.EMPTY))
            .add(new SessionCommand(QueuePlayer.CMD_SET_SHUFFLE, Bundle.EMPTY))
            .add(new SessionCommand(QueuePlayer.CMD_SKIP_TO_PREVIOUS, Bundle.EMPTY))
            .add(new SessionCommand(QueuePlayer.CMD_SKIP_TO_INDEX, Bundle.EMPTY))
            .build();

        MediaSession.ConnectionResult.AcceptedResultBuilder builder =
            new MediaSession.ConnectionResult.AcceptedResultBuilder(session).setAvailableSessionCommands(sessionCommands);

        // Action enablement (best-effort) based on playback options.
        try {
            Player.Commands.Builder cmds = MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS.buildUpon();
            QueueModels.PlaybackOptions opts = queuePlayer.getOptionsSnapshot();

            if (!opts.enableNextPrev) {
                cmds.remove(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM);
                cmds.remove(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM);
                cmds.remove(Player.COMMAND_SEEK_TO_NEXT);
                cmds.remove(Player.COMMAND_SEEK_TO_PREVIOUS);
            }
            if (!opts.enableSeekTo) {
                cmds.remove(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM);
            }
            if (!opts.enableStop) {
                cmds.remove(Player.COMMAND_STOP);
            }

            builder.setAvailablePlayerCommands(cmds.build());
        } catch (Exception ignored) {}

        return builder.build();
    }

    @Override
    public ListenableFuture<SessionResult> onCustomCommand(
        MediaSession session,
        MediaSession.ControllerInfo controller,
        SessionCommand customCommand,
        Bundle args
    ) {
        try {
            String json = args != null ? args.getString("json") : null;
            JSONObject payload = json != null ? new JSONObject(json) : new JSONObject();
            return queuePlayer.handleCustomCommand(session, customCommand, payload);
        } catch (Exception e) {
            return Futures.immediateFuture(new SessionResult(SessionResult.RESULT_ERROR_UNKNOWN));
        }
    }
}
