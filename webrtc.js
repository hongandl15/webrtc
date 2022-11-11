class Webrtc extends EventTarget {
    constructor(
        socket,
        pcConfig = null,
        logging = { log: true, warn: true, error: true }
    ) {
        super();
        this.room;
        this.socket = socket;
        this.pcConfig = pcConfig;

        this._myId = null;
        this.pcs = {}; 
        this.streams = {};
        this.currentRoom;
        this.inCall = false;
        this.isReady = false; 
        this.isInitiator = false; 
        this._isAdmin = false; 
        this._localStream = null;

        this._onSocketListeners();
    }

    // Custom event emitter
    _emit(eventName, details) {
        this.dispatchEvent(
            new CustomEvent(eventName, {
                detail: details,
            })
        );
    }

    get localStream() {
        return this._localStream;
    }

    get myId() {
        return this._myId;
    }

    get isAdmin() {
        return this._isAdmin;
    }

    get roomId() {
        return this.room;
    }

    get participants() {
        return Object.keys(this.pcs);
    }

    gotStream() {
        if (this.room) {
            this._sendMessage({ type: 'gotstream' }, null, this.room);
        } else {
            this._emit('notification', {
                notification: `Tham gia phòng trước khi send stream.`,
            });
        }
    }

    joinRoom(room) {
        if (this.room) {

            this._emit('notification', {
                notification: `Rời khỏi phòng trước khi tham gia phòng mới`,
            });
            return;
        }
        if (!room) {

            this._emit('notification', {
                notification: `ID phòng không tồn tại`,
            });
            return;
        }
        this.socket.emit('create or join', room);
    }

    leaveRoom() {
        if (!this.room) {
            this._emit('notification', {
                notification: `Bạn vẫn chưa ở trong phòng`,
            });
            return;
        }
        this.isInitiator = false;
        this.socket.emit('leave room', this.room);
    }

    // Get local stream
    getLocalStream(audioConstraints, videoConstraints) {
        return navigator.mediaDevices
            .getUserMedia({
                audio: audioConstraints,
                video: videoConstraints,
            })
            .then((stream) => {
                this._localStream = stream;
                return stream;
            })
            .catch(() => {

                this._emit('error', {
                    error: new Error(`Can't get usermedia`),
                });
            });
    }

    /**
     * Try connecting to peers
     * if got local stream and is ready for connection
     */
    _connect(socketId) {
        if (typeof this._localStream !== 'undefined' && this.isReady) {

            this._createPeerConnection(socketId);
            this.pcs[socketId].addStream(this._localStream);

            if (this.isInitiator) {
                this._makeOffer(socketId);
            }
        } else {
        }
    }

    _onSocketListeners() {

        // Room got created
        this.socket.on('created', (room, socketId) => {
            this.room = room;
            this._myId = socketId;
            this.isInitiator = true;
            this._isAdmin = true;

            this._emit('createdRoom', { roomId: room });
        });

        // Joined the room
        this.socket.on('joined', (room, socketId) => {

            this.room = room;
            this.isReady = true;
            this._myId = socketId;

            this._emit('joinedRoom', { roomId: room });
        });

        // Left the room
        this.socket.on('left room', (room) => {
            if (room === this.room) {

                this.room = null;
                this._removeUser();
                this._emit('leftRoom', {
                    roomId: room,
                });
            }
        });

        // Someone joins room
        this.socket.on('join', (room) => {

            this.isReady = true;

            this.dispatchEvent(new Event('newJoin'));
        });

        // Room is ready for connection
        this.socket.on('ready', (user) => {
            this.log('User: ', user, ' joined room');

            if (user !== this._myId && this.inCall) this.isInitiator = true;
        });

        // Someone got kicked from call
        this.socket.on('kickout', (socketId) => {

            if (socketId === this._myId) {
                // You got kicked out
                this.dispatchEvent(new Event('kicked'));
                this._removeUser();
            } else {
                // Someone else got kicked out
                this._removeUser(socketId);
            }
        });

        // Logs from server
        this.socket.on('log', (log) => {
            this.log.apply(console, log);
        });

        /**
         * Message from the server
         * Manage stream and sdp exchange between peers
         */
        this.socket.on('message', (message, socketId) => {

            // Participant leaves
            if (message.type === 'leave') {
                this._removeUser(socketId);
                this.isInitiator = true;

                this._emit('userLeave', { socketId: socketId });
                return;
            }

            // Avoid dublicate connections
            if (
                this.pcs[socketId] &&
                this.pcs[socketId].connectionState === 'connected'
            ) {
                return;
            }

            switch (message.type) {
                case 'gotstream': // user is ready to share their stream
                    this._connect(socketId);
                    break;
                case 'offer': // got connection offer
                    if (!this.pcs[socketId]) {
                        this._connect(socketId);
                    }
                    this.pcs[socketId].setRemoteDescription(
                        new RTCSessionDescription(message)
                    );
                    this._answer(socketId);
                    break;
                case 'answer': // got answer for sent offer
                    this.pcs[socketId].setRemoteDescription(
                        new RTCSessionDescription(message)
                    );
                    break;
                case 'candidate': // received candidate sdp
                    this.inCall = true;
                    const candidate = new RTCIceCandidate({
                        sdpMLineIndex: message.label,
                        candidate: message.candidate,
                    });
                    this.pcs[socketId].addIceCandidate(candidate);
                    break;
            }
        });
    }

    _sendMessage(message, toId = null, roomId = null) {
        this.socket.emit('message', message, toId, roomId);
    }

    _createPeerConnection(socketId) {
        try {
            if (this.pcs[socketId]) {
                // Skip peer if connection is already established
                return;
            }

            this.pcs[socketId] = new RTCPeerConnection(this.pcConfig);
            this.pcs[socketId].onicecandidate = this._handleIceCandidate.bind(
                this,
                socketId
            );
            this.pcs[socketId].ontrack = this._handleOnTrack.bind(
                this,
                socketId
            );

        } catch (error) {
            this._emit('error', {
                error: new Error(`RTCPeerConnection failed: ${error.message}`),
            });
        }
    }

    /**
     * Send ICE candidate through signaling server (socket.io in this case)
     */
    _handleIceCandidate(socketId, event) {

        if (event.candidate) {
            this._sendMessage(
                {
                    type: 'candidate',
                    label: event.candidate.sdpMLineIndex,
                    id: event.candidate.sdpMid,
                    candidate: event.candidate.candidate,
                },
                socketId
            );
        }
    }

    _handleCreateOfferError(event) {

        this._emit('error', {
            error: new Error('Error while creating an offer'),
        });
    }

    /**
     * Make an offer
     * Creates session descripton
     */
    _makeOffer(socketId) {

        this.pcs[socketId].createOffer(
            this._setSendLocalDescription.bind(this, socketId),
            this._handleCreateOfferError
        );
    }

    /**
     * Create an answer for incoming offer
     */
    _answer(socketId) {

        this.pcs[socketId]
            .createAnswer()
            .then(
                this._setSendLocalDescription.bind(this, socketId),
                this._handleSDPError
            );
    }

    /**
     * Set local description and send it to server
     */
    _setSendLocalDescription(socketId, sessionDescription) {
        this.pcs[socketId].setLocalDescription(sessionDescription);
        this._sendMessage(sessionDescription, socketId);
    }

    _handleSDPError(error) {

        this._emit('error', {
            error: new Error(`Session description error: ${error.toString()}`),
        });
    }

    _handleOnTrack(socketId, event) {

        if (this.streams[socketId]?.id !== event.streams[0].id) {
            this.streams[socketId] = event.streams[0];

            this._emit('newUser', {
                socketId,
                stream: event.streams[0],
            });
        }
    }

    _handleUserLeave(socketId) {
        this._removeUser(socketId);
        this.isInitiator = false;
    }

    _removeUser(socketId = null) {
        if (!socketId) {
            // close all connections
            for (const [key, value] of Object.entries(this.pcs)) {
                value.close();
                delete this.pcs[key];
            }
            this.streams = {};
        } else {
            if (!this.pcs[socketId]) return;
            this.pcs[socketId].close();
            delete this.pcs[socketId];

            delete this.streams[socketId];
        }

        this._emit('removeUser', { socketId });
    }

    kickUser(socketId) {
        if (!this.isAdmin) {
            this._emit('notification', {
                notification: 'You are not an admin',
            });
            return;
        }
        this._removeUser(socketId);
        this.socket.emit('kickout', socketId, this.room);
    }
}
