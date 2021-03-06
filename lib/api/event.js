// Cronicle API Layer - Events
// Copyright (c) 2015 Joseph Huckaby
// Released under the MIT License

var fs = require('fs');
var assert = require("assert");
var async = require('async');

var Class = require("pixl-class");
var Tools = require("pixl-tools");

module.exports = Class.create({
	
	//
	// Events:
	//
	
	api_get_schedule: function(args, callback) {
		// get list of scheduled events (with pagination)
		var self = this;
		var params = Tools.mergeHashes( args.params, args.query );
		if (!this.requireMaster(args, callback)) return;
		
		this.loadSession(args, function(err, session, user) {
			if (err) return self.doError('session', err.message, callback);
			if (!self.requireValidUser(session, user, callback)) return;
			
			self.storage.listGet( 'global/schedule', params.offset || 0, params.limit || 50, function(err, items, list) {
				if (err) {
					// no items found, not an error for this API
					return callback({ code: 0, rows: [], list: { length: 0 } });
				}
				
				// success, return keys and list header
				callback({ code: 0, rows: items, list: list });
			} ); // got event list
		} ); // loaded session
	},
	
	api_get_event: function(args, callback) {
		// get single event for editing
		var self = this;
		var params = Tools.mergeHashes( args.params, args.query );
		if (!this.requireMaster(args, callback)) return;
		
		if (!this.requireParams(params, {
			id: /^\w+$/
		}, callback)) return;
		
		this.loadSession(args, function(err, session, user) {
			if (err) return self.doError('session', err.message, callback);
			if (!self.requireValidUser(session, user, callback)) return;
			
			self.storage.listFind( 'global/schedule', { id: params.id }, function(err, item) {
				if (err || !item) {
					return self.doError('event', "Failed to locate event: " + params.id, callback);
				}
				
				// success, return event
				callback({ code: 0, event: item });
			} ); // got event
		} ); // loaded session
	},
	
	api_create_event: function(args, callback) {
		// add new event
		var self = this;
		var event = args.params;
		if (!this.requireMaster(args, callback)) return;
		
		if (!this.requireParams(event, {
			title: /\S/,
			enabled: /^(1|0)$/,
			category: /^\w+$/,
			target: /^[\w\-\.]+$/,
			plugin: /^\w+$/
		}, callback)) return;
		
		this.loadSession(args, function(err, session, user) {
			if (err) return self.doError('session', err.message, callback);
			if (!self.requireValidUser(session, user, callback)) return;
			if (!self.requirePrivilege(user, "create_events", callback)) return;
			
			args.user = user;
			args.session = session;
			
			if (event.id) event.id = event.id.toString().toLowerCase().replace(/\W+/g, '');
			if (!event.id) event.id = self.getUniqueID('e');
			
			event.created = event.modified = Tools.timeNow(true);
			
			if (!event.max_children) event.max_children = 0;
			if (!event.timeout) event.timeout = 0;
			if (!event.timezone) event.timezone = self.tz;
			if (!event.params) event.params = {};
			
			if (user.key) {
				// API Key
				event.api_key = user.key;
			}
			else {
				event.username = user.username;
			}
			
			self.logDebug(6, "Creating new event: " + event.title, event);
			
			self.storage.listUnshift( 'global/schedule', event, function(err) {
				if (err) {
					return self.doError('event', "Failed to create event: " + err, callback);
				}
				
				self.logDebug(6, "Successfully created event: " + event.title, event);
				self.logTransaction('event_create', event.title, self.getClientInfo(args, { event: event }));
				self.logActivity('event_create', { event: event }, args);
				
				callback({ code: 0, id: event.id });
				
				// broadcast update to all websocket clients
				self.updateClientData( 'schedule' );
				
				// create cursor for new event
				var now = Tools.normalizeTime( Tools.timeNow(), { sec: 0 } );
				self.state.cursors[ event.id ] = now;
				
				// send new state data to all web clients
				self.authSocketEmit( 'update', { state: self.state } );
				
			} ); // list insert
		} ); // load session
	},
	
	api_update_event: function(args, callback) {
		// update existing event
		var self = this;
		var params = args.params;
		if (!this.requireMaster(args, callback)) return;
		
		if (!this.requireParams(params, {
			id: /^\w+$/
		}, callback)) return;
		
		this.loadSession(args, function(err, session, user) {
			if (err) return self.doError('session', err.message, callback);
			if (!self.requireValidUser(session, user, callback)) return;
			if (!self.requirePrivilege(user, "edit_events", callback)) return;
			if (params.abort_jobs && !self.requirePrivilege(user, "abort_events", callback)) return;
			
			args.user = user;
			args.session = session;
			
			self.storage.listFind( 'global/schedule', { id: params.id }, function(err, event) {
				if (err || !event) {
					return self.doError('event', "Failed to locate event: " + params.id, callback);
				}
				
				params.modified = Tools.timeNow(true);
				
				self.logDebug(6, "Updating event: " + event.title, params);
				
				// pull cursor reset out of event object, for use later
				var new_cursor = 0;
				if (params.reset_cursor) {
					new_cursor = Tools.normalizeTime(params.reset_cursor - 60, { sec: 0 });
					delete params.reset_cursor;
				}
				
				// pull abort flag out of event object, for use later
				var abort_jobs = 0;
				if (params.abort_jobs) {
					abort_jobs = params.abort_jobs;
					delete params.abort_jobs;
				}
				
				self.storage.listFindUpdate( 'global/schedule', { id: params.id }, params, function(err) {
					if (err) {
						return self.doError('event', "Failed to update event: " + err, callback);
					}
					
					// merge params into event, just so we have the full updated record
					for (var key in params) event[key] = params[key];
					
					// optionally reset cursor
					if (new_cursor) {
						var dargs = Tools.getDateArgs( new_cursor );
						self.logDebug(6, "Resetting event cursor to: " + dargs.yyyy_mm_dd + ' ' + dargs.hh_mi_ss);
						self.state.cursors[ params.id ] = new_cursor;
						
						// send new state data to all web clients
						self.authSocketEmit( 'update', { state: self.state } );
					}
					
					self.logDebug(6, "Successfully updated event: " + event.id + " (" + event.title + ")");
					self.logTransaction('event_update', event.title, self.getClientInfo(args, { event: params }));
					self.logActivity('event_update', { event: params }, args);
					
					// send response to web client
					callback({ code: 0 });
					
					// broadcast update to all websocket clients
					self.updateClientData( 'schedule' );
					
					// if event is disabled, abort all applicable jobs
					if (!event.enabled && abort_jobs) {
						var all_jobs = self.getAllActiveJobs(true);
						for (var key in all_jobs) {
							var job = all_jobs[key];
							if ((job.event == event.id) && !job.detached) {
								var msg = "Event '" + event.title + "' has been disabled.";
								self.logDebug(4, "Job " + job.id + " is being aborted: " + msg);
								self.abortJob({ id: job.id, reason: msg });
							} // matches event
						} // foreach job
					} // event disabled
					
					// if this is a catch_up event and is being enabled, force scheduler to re-tick the minute
					var dargs = Tools.getDateArgs( new Date() );
					if (params.enabled && event.catch_up && !self.schedulerGraceTimer && !self.schedulerTicking && (dargs.sec != 59)) {
						self.schedulerMinuteTick( null, true );
					}
				} ); // update event
			} ); // find event
		} ); // load session
	},
	
	api_delete_event: function(args, callback) {
		// delete existing event
		var self = this;
		var params = args.params;
		if (!this.requireMaster(args, callback)) return;
		
		if (!this.requireParams(params, {
			id: /^\w+$/
		}, callback)) return;
		
		this.loadSession(args, function(err, session, user) {
			if (err) return self.doError('session', err.message, callback);
			if (!self.requireValidUser(session, user, callback)) return;
			if (!self.requirePrivilege(user, "delete_events", callback)) return;
			
			args.user = user;
			args.session = session;
			
			// Do not allow deleting event if any active jobs
			var all_jobs = self.getAllActiveJobs(true);
			for (var key in all_jobs) {
				var job = all_jobs[key];
				if (job.event == params.id) {
					var err = "Still has running jobs";
					return self.doError('event', "Failed to delete event: " + err, callback);
				} // matches event
			} // foreach job
			
			self.logDebug(6, "Deleting event: " + params.id);
			
			self.storage.listFindDelete( 'global/schedule', { id: params.id }, function(err, event) {
				if (err) {
					return self.doError('event', "Failed to delete event: " + err, callback);
				}
				
				self.logDebug(6, "Successfully deleted event: " + event.title, event);
				self.logTransaction('event_delete', event.title, self.getClientInfo(args, { event: event }));
				self.logActivity('event_delete', { event: event }, args);
				
				callback({ code: 0 });
				
				// broadcast update to all websocket clients
				self.updateClientData( 'schedule' );
				
				// schedule event's activity log to be deleted at next maint run
				self.storage.expire( 'logs/events/' + event.id, Tools.timeNow(true) + 86400 );
				
				// delete state data
				delete self.state.cursors[ event.id ];
				if (self.state.robins) delete self.state.robins[ event.id ];
				
				// send new state data to all web clients
				self.authSocketEmit( 'update', { state: self.state } );
				
			} ); // delete
		} ); // load session
	},
	
	api_run_event: function(args, callback) {
		// run event manually (via "Run" button in UI or by API Key)
		// can include any event overrides in params (such as 'now')
		var self = this;
		var params = args.params;
		if (!this.requireMaster(args, callback)) return;
		
		if (!this.requireParams(params, {
			id: /^\w+$/
		}, callback)) return;
		
		this.loadSession(args, function(err, session, user) {
			if (err) return self.doError('session', err.message, callback);
			if (!self.requireValidUser(session, user, callback)) return;
			if (!self.requirePrivilege(user, "run_events", callback)) return;
			
			args.user = user;
			args.session = session;
			
			self.storage.listFind( 'global/schedule', { id: params.id }, function(err, event) {
				if (err) {
					return self.doError('event', "Failed to load event: " + err, callback);
				}
				
				delete params.id;
				var job = Tools.mergeHashes( Tools.copyHash(event, true), params );
				if (user.key) {
					// API Key
					job.source = "API Key ("+user.title+")";
					job.api_key = user.key;
				}
				else {
					job.source = "Manual ("+user.username+")";
					job.username = user.username;
				}
				
				self.logDebug(6, "Running event manually: " + job.title, job);
				
				self.launchJob( job, function(err, jobs_launched) {
					if (err) {
						return self.doError('event', "Failed to launch event: " + err.message, callback);
					}
					
					// multiple jobs may have been launched (multiplex)
					var ids = [];
					for (var idx = 0, len = jobs_launched.length; idx < len; idx++) {
						var job = jobs_launched[idx];
						var stub = { id: job.id, event: job.event };
						self.logTransaction('job_run', job.event_title, self.getClientInfo(args, stub));
						self.logActivity('job_run', stub, args);
						ids.push( job.id );
					}
					
					callback({ code: 0, ids: ids });
				} ); // launch job
			} ); // find event
		} ); // load session
	},
	
	api_get_event_history: function(args, callback) {
		// get event history
		var self = this;
		var params = Tools.mergeHashes( args.params, args.query );
		
		if (!this.requireParams(params, {
			id: /^\w+$/
		}, callback)) return;
		
		this.loadSession(args, function(err, session, user) {
			if (err) return self.doError('session', err.message, callback);
			if (!self.requireValidUser(session, user, callback)) return;
			if (!self.requirePrivilege(user, "edit_events", callback)) return;
						
			args.user = user;
			args.session = session;
			
			self.storage.listGet( 'logs/events/' + params.id, params.offset || 0, params.limit || 100, function(err, items, list) {
				if (err) {
					// no rows found, not an error for this API
					return callback({ code: 0, rows: [], list: { length: 0 } });
				}
				
				// success, return rows and list header
				callback({ code: 0, rows: items, list: list });
			} ); // got data
			
		} ); // load session
	},
	
	api_get_history: function(args, callback) {
		// get list of completed jobs for ALL events (with pagination)
		var self = this;
		var params = Tools.mergeHashes( args.params, args.query );
		
		this.loadSession(args, function(err, session, user) {
			if (err) return self.doError('session', err.message, callback);
			if (!self.requireValidUser(session, user, callback)) return;
			
			self.storage.listGet( 'logs/completed', params.offset || 0, params.limit || 50, function(err, items, list) {
				if (err) {
					// no rows found, not an error for this API
					return callback({ code: 0, rows: [], list: { length: 0 } });
				}
				
				// success, return rows and list header
				callback({ code: 0, rows: items, list: list });
			} ); // got data
		} ); // loaded session
	}
	
} );
