var app = require('express')();
var server = require('http').Server(app);
var io = require('socket.io')(server);
var crypto = require('crypto');
var fs = require('fs');
var NodeRSA = require('node-rsa');
var path = require('path');

server.listen(3000);

// global variables for the server
var enemies = [];
var playerSpawnPoints = [];
var clients = [];
var clientKeys = {};
var clientNonces = {};
var pemKey = ''; //This is the private server key
var privateKeyPath = path.join(__dirname, 'private_key.txt');


pemKey = fs.readFileSync(privateKeyPath, 'utf8');

var privateKey = new NodeRSA(pemKey);

io.on('connection', function(socket){

	var currentPlayer = {};
	currentPlayer.name = 'unknown';
	socket.on('check username', function(data){
		console.log('recv: check username:' + data.username);
		if(clients.length==0){
			rep = {
				reply : "yes"
			};
			socket.emit('can login', rep);
			return;
		}
		for(i = 0; i<clients.length; i++){
			if(clients[i].name == data.username){
				rep = {
					reply : "no"
				};
				socket.emit('can login', rep);
				return;		
			}
		}
		rep = {
				reply : "yes"
			};
		socket.emit('can login', rep);
	})

	socket.on('player connect', function(){
		console.log(currentPlayer.name+ ' recv: player connect');
		for(var i=0; i<clients.length;i++){
			var playerConnected = {
				name:clients[i].name,
				position:clients[i].position,
				rotation:clients[i].rotation,
				health:clients[i].health
			}
			// in your current game, we need to tell you about the other players
			socket.emit('other player connected', playerConnected);
			console.log(currentPlayer.name +' emit: other player connected: ' + JSON.stringify(playerConnected));
		}
	})

	socket.on('play', function(data){
		console.log(currentPlayer.name+' recv: play: ' + JSON.stringify(data));
		//if this is the first person to join the game init the enemies
		if(clients.length == 0){
			numberOfEnemies = data.enemySpawnPoints.length;
			enemies = [];
			data.enemySpawnPoints.forEach(function(enemySpawnPoint){
				var enemy = {
					name: guid(),
					position: enemySpawnPoint.position,
					rotation: enemySpawnPoint.rotation,
					health: 100
				};
				enemies.push(enemy);
			});
			playerSpawnPoints = [];
			data.playerSpawnPoints.forEach(function(_playerSpawnPoint){
				var playerSpawnPoint = {
					position : _playerSpawnPoint.position,
					rotation : _playerSpawnPoint.rotation
				};
				playerSpawnPoints.push(playerSpawnPoint);
			});
		}

		var enemiesResponse = {
			enemies: enemies
		};
		//we always will send the enemies when the player joins
		console.log(currentPlayer.name + ' emit: enemies: ' + JSON.stringify(enemiesResponse));
		socket.emit('enemies', enemiesResponse);
		var randomSpawnPoint = playerSpawnPoints[Math.floor(Math.random() * playerSpawnPoints.length)];
		currentPlayer = {
			name:data.name,
			position: randomSpawnPoint.position,
			rotation: randomSpawnPoint.rotation,
			health: 100
		};


		var buf = Buffer.from(data.publicKey, 'base64');
		var publicKey = crypto.privateDecrypt({"key":pemKey, "padding":crypto.constants.RSA_NO_PADDING}, buf);


		var playerPublicKey = publicKey.toString().substring(publicKey.toString().indexOf('-----BEGIN'));
		clientKeys[currentPlayer.name] = playerPublicKey;

		//Decrypting with server private Key
		var noncebuf = Buffer.from(data.nonce, 'base64');
		var noncebufDecrypted = crypto.privateDecrypt({"key":pemKey, "padding":crypto.constants.RSA_NO_PADDING}, noncebuf).toString('utf8').replace(/\0/g, '');
		
		//Decrypting with user public key
		nonceBuf = Buffer.from(noncebufDecrypted, 'base64');
		var decryptednonce = crypto.publicDecrypt({"key":playerPublicKey, "padding":crypto.constants.RSA_NO_PADDING}, nonceBuf).toString('utf8').trim().replace(/\0/g, '');
		
		clientNonces[currentPlayer.name] = parseInt(decryptednonce);
		//console.log("Client public key:\n" + publicKey)
		/////////////////////////////
		clients.push(currentPlayer);
		// in your current game, tell you that you have joined
		console.log(currentPlayer.name+' emit: play: ' + JSON.stringify(currentPlayer));
		socket.emit('play', currentPlayer);
		// in your current game, we need to tell the other players about you.
		socket.broadcast.emit('other player connected', currentPlayer);
	});

	socket.on('player move safe', function(data){
		//console.log('recv: move: ' + JSON.stringify(data));
		currentPlayer.position = data.position;
		//{name:, positionx, y, z}
		socket.broadcast.emit('player move', currentPlayer);
	});

	socket.on('player move', function(data){
		//console.log('recv: move: ' + JSON.stringify(data));

		var json = JSON.parse(data.json);
		//Signature verification BEGIN
		if(clientKeys[json.name] === "undefined"){
			console.log('User does not exist');
			return;
		}
		clientNonces[json.name] = (clientNonces[json.name] + 1)%10000;
		nonce = clientNonces[json.name].toString();

		var buf = Buffer.from(data.signature, 'base64');
		
		var playerPublicKey = clientKeys[json.name];
		var decryptedSignature = crypto.publicDecrypt({"key":playerPublicKey, "padding":crypto.constants.RSA_NO_PADDING}, buf).toString('utf8').trim().replace(/\0/g, '');
		var jsonData = data.json
		var md5sum = crypto.createHash('md5').update(jsonData+nonce).digest("hex").toUpperCase();
		
		// if(md5sum != decryptedSignature){
		// 	console.log('Dropped message');
		// 	return;
		// }
		//Signature verification END

		clientChanged = null;
		for (var i = 0; i < clients.length; i++) {
			if(json.name == clients[i].name){
				clients[i].position = json.position;
				clientChanged = clients[i];
				break;
			}
		}
		if(clientChanged!=null){
			socket.broadcast.emit('player move', clientChanged);
		}
	});

	socket.on('player turn', function(data){
		//console.log('recv: move: ' + JSON.stringify(data));
		currentPlayer.rotation = data.rotation;
		socket.broadcast.emit('player turn', currentPlayer);
	});

	socket.on('player shoot', function(){
		//console.log(currentPlayer.name + ' recv: shoot');
		var data = {
			name: currentPlayer.name
		};
		console.log(currentPlayer.name + ' bcst: shoot: ' + JSON.stringify(data));
		socket.emit('player shoot', data);
		socket.broadcast.emit('player shoot', data);
	});

	socket.on('health', function(data){
		//console.log(currentPlayer.name+ ' recv: health: ' + JSON.stringify(data));
		//only change the health once, we can do this by checking the originating player
		if(data.from === currentPlayer.name){
			var indexDamaged = 0;
			if(!data.isEnemy){
				clients = clients.map(function(client, index){
					if(client.name === data.name){
						indexDamaged = index;
						client.health -= data.healthChange;
					}
					return client
				});
			}
			else{
				enemies = enemies.map(function(enemy, index){
					if(enemy.name === data.name){
						indexDamaged = index;
						enemy.health -= data.healthChange;
					}
					return enemy;
				});
			}

			var response = {
				name: (!data.isEnemy) ? clients[indexDamaged].name : enemies[indexDamaged].name,
				health: (!data.isEnemy) ? clients[indexDamaged].health : enemies[indexDamaged].health
			};
			console.log(currentPlayer.name + ' bcst: health: ' + JSON.stringify(response));
			socket.emit('health', response);
			socket.broadcast.emit('health', response);
		}
	});
	socket.on('restoreHealth', function(){
		//console.log(' Restoring health ');
		currentPlayer.health = 100;
		var response = {
				name: currentPlayer.name,
				health: 100
			};
		socket.emit('health', response);
		socket.broadcast.emit('health', response);
	});

	socket.on('disconnect', function(){
		console.log(currentPlayer.name+ ' recv: disconnect ' + currentPlayer.name);
		socket.broadcast.emit('other player disconnected', currentPlayer);
		console.log(currentPlayer.name + ' bcst: other player disconnected ' + JSON.stringify(currentPlayer));
		for(var i=0; i<clients.length; i++){
			if(clients[i].name === currentPlayer.name){
				clients.splice(i,1);
			}
		}
	});
});

console.log('---server is runnning---');

function guid() {
	function s4() {
		return Math.floor((1+Math.random()) * 0x10000).toString(16).substring(1);
	}
	return s4() + s4() +'-'+ s4() + '-'+ s4() +'-'+ s4() + '-' + s4() + s4() + s4();
}