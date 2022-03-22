//Create express app
const express = require('express');
let app = express();

const mc = require("mongodb").MongoClient;
const elasticlunr = require("elasticlunr");
const {Matrix} = require("ml-matrix");

let alpha = 0.1;
let euclDist = 0.0001;

let db;

const Crawler = require("crawler");

const path = require('path');

//Used to make sure that there aren't 2 entries for the same page due to async programming
let creatingEntry = {};

let gcVisited = ['https://www.canada.ca/en.html'];
let gcVisitedCount = 1;
let gcAddedCount = 0;
let gcID = 0;

//Index for the personal pages
const gcIndex = elasticlunr(function (){
	this.addField('page');
	this.addField('text');
	this.addField('url');
	this.addField('pagerank');
	this.setRef('id');
});

//Creating the crawler for the gc pages
const gcCrawler = new Crawler({
	maxConnections : 10,

	//Function called for each new page crawled
	callback : function (error, res, done) {
			if(error){
					console.log(error);
			//Only crawling a page if it's html
			}else if (res['headers']['content-type'].startsWith('text/html')){
					let $ = res.$;
					let uri = res['options']['uri'];

					let text = "";

					//Getting all of the text from the page
					let paragraphs = $('p');
					$(paragraphs).each(function(i, paragraph){
						text += $(paragraph).text();
					});
					let elements = $('a');
					$(elements).each(function(i, element){
						text += $(element).text();
					});
					let divs = $('div');
					$(divs).each(function(i, div){
						text += $(div).text();
					});

					//Getting the links and looping through each one while ensuring that it is a valid type of link
					let links = $("a");
					let outgoingList = [];

					$(links).each(function(i, link){
						if ($(link).attr("href") && !$(link).attr("href").startsWith("http") && !$(link).attr("href").startsWith("#") && $(link).attr("href").startsWith("/")){
							outgoingList.push('https://www.canada.ca' + $(link).attr('href'));
						}
					});

					//Ensuring that the data for the first page is getting added correctly
					if (uri == 'https://www.canada.ca/en.html'){
						gcID++;
						gcAddedCount++;
						db.collection("PersonalPages").insertOne({
							page : $("title").text(),
							id : gcID,
							url : uri,
							outgoingLinks : outgoingList,
							text : text},
							function(err,result){
								if (err) throw err;
						});
					}else{
						//Adds the text/outgoing links to an entry
						function addText(){
							db.collection("PersonalPages").updateOne({
								url : uri},
								{$set : {outgoingLinks : outgoingList, text : text}},
								function(err,result){
									if (err) throw err;
								});
							}
						//Not updating the entry until it is done being created
						if (creatingEntry[uri] == true){
							setTimeout(addText, 50);
						}else {
							addText();
						}
					}

					//Almost all pages contain 2 copies of the link to the french/english homes pages, and it ends up seriously affecting crawl results.
					//This helps negate the second link
					let englishAdded = false;
					let frenchAdded = false;

					//looping through each link
					$(links).each(function(i, link){

						//Checking to make sure that the link isn't to another domain (most links just start with a '/'), or just another part
						//of the current page, as well as other checks to make sure the link is valid
						if ($(link).attr("href") && !$(link).attr("href").startsWith("http") && !$(link).attr("href").startsWith("#") && $(link).attr("href").startsWith("/") && !$(link).attr("href").endsWith(".pdf") && !$(link).attr("href").endsWith(".PDF")){
							if (!($(link).attr("href") == "/en.html" && englishAdded) && !($(link).attr("href") == "/fr.html" && frenchAdded)){

								if ($(link).attr("href") == "/en.html"){
									englishAdded = true;
								}else if ($(link).attr("href") == "/fr.html"){
									frenchAdded = true;
								}

								//Checking to see if the page has been added to the db
								db.collection("PersonalPages").findOne({url : 'https://www.canada.ca' + $(link).attr('href')}, function(err,result){
									if(err) throw err;

									//Updating if the page is already in db
									if (result){
										db.collection("PersonalPages").updateOne({url : 'https://www.canada.ca' + $(link).attr('href')}, {$inc : {count : 1}, $push: {incomingLinks : uri}}, function(err,result){
											if(err) throw err;
										});
									}else{
											//Putting a "hold" on so that two entries don't get created for the same page
											if (creatingEntry['https://www.canada.ca' + $(link).attr('href')] == true){

												//Waiting until the record has been (asyncronously) created
												function updateNow(){
													db.collection("PersonalPages").updateOne({url : 'https://www.canada.ca' + $(link).attr('href')}, {$inc : {count : 1}, $push: {incomingLinks : uri}}, function(err,result){
														if(err) throw err;
													});
												}
												setTimeout(updateNow, 50);

											//Adding an entry to the db since the page is not there yet
											}else{
												//Making sure we have reached our page limit yet
												if (gcAddedCount < 1000){
													gcAddedCount++;

													gcID++;
													let url = "";

													//Most links did not include this "https://www.canada.ca" part
													if (!$(link).attr("href").startsWith("http")){
														url += "https://www.canada.ca";
													}

													url += $(link).attr("href");
													creatingEntry[url] = true;

													//Adding the link to the queue
													gcCrawler.queue('https://www.canada.ca' + $(link).attr('href'));

													//Inserting the new entry into the db
													db.collection("PersonalPages").insertOne({count : 1, page : $(link).text(), id : gcID, url : url, incomingLinks : [uri]}, function(err,result){
														if(err) throw err;

														creatingEntry[url] = false;
													});
												}
											}
									}
								});
							}
						}
					});
			}
		done();
	}
});

app.set("view engine", "pug");

//Setting up the routes
app.use(express.static("public"));
app.use(express.json());

app.get('/personal', sendPersonal);
app.get('/personal/:ID', getPersonal);

//Executes when the queue is empty (no more pages to crawl)
gcCrawler.on('drain',function(){
	console.log("Done GC crawling.");
});

//Does a search in the personal db
function sendPersonal(req, res, next){
	//Getting the query parameters and doing input validation
	let query, limit, boost;

	//Getting the query parameters
	if (req.query.boost){
		boost = req.query.boost;
	}else{
		boost = false;
	}
	if (req.query.limit){
			limit = parseInt(req.query.limit);
	}else {
		limit = 10;
	}

	//Only using the index if the "q" parameter was specified
	if (req.query.q){
		query = req.query.q;

		//Searching the index
		let result = gcIndex.search(query, {});

		if (result.length < limit){
			limit = result.length;
		}

		let shortenedResult = [];

		//Creating new objects that are easier to work with
		for (let i=0; i<result.length; i++) {
				let newObj = {
					id : result[i]["ref"],
					score : result[i]["score"],
					page : gcIndex["documentStore"]["docs"][result[i]["ref"]]["page"],
					pagerank : gcIndex["documentStore"]["docs"][result[i]["ref"]]["pagerank"],
					url : gcIndex["documentStore"]["docs"][result[i]["ref"]]["url"]
				}

				//Boosting the elasticlunr score
				if (boost == "true"){
					//I decided to multiply all scores by 1000 so that each score should be around 1
					newObj["score"] = newObj["score"] * newObj["pagerank"] * 1000;
				}

				shortenedResult.push(newObj);
		}

		//Sorting the boosted results
		if (boost == "true"){
			query += "\n(elasticlunr scores boosted with pagerank)";

			//Sorting to get the pages with the highest rank
			shortenedResult.sort(function(a,b){return b["score"] - a["score"]});
		}

		//Getting the top 10 results
		shortenedResult = shortenedResult.slice(0, limit);

		//Limiting the results to 10 items, then formatting results into an html page using pug.
		if (result.length > 0){
			res.render("GCResult.pug", {results : shortenedResult, search : query});
		}else{
			res.status(404).send("Sorry, there are no results for that search.")
		}
	}else {
		//Allowing the user to still get some kind of result even if they don't specify a search string.
		//Given that there is no search string, there is no use in using elasticlunr here.
		db.collection("PersonalPages").find().limit(parseInt(limit)).toArray(function(err, result){
			if(err) throw err;

			let modifiedResult = [];

			//Creating new object to match the format that the pug file is expecting
			for (i in result) {
				result[i]["score"] = "No search string entered, elasticlunr was not used.";
			}

			res.render("GCResult.pug", {results : result, search : "No search string specified, these are just random pages."});
		});
	}

}

//Sending the info for a specific page
function getPersonal(req, res, next){
	let id = req.params.ID;

	//Searching the db
	db.collection("PersonalPages").findOne({id : parseInt(id)},function(err, result){
		if(err) throw err;

		if (result){
			//Moving the object into an array that easier to display in pug
			let wcArr = [];
			for (word in result["wordCounts"]){
				wcArr.push(word + ": " + result["wordCounts"][word])
			}

			result["wordCounts"] = wcArr;

			res.render("SinglePage.pug", {result : result});
		}else{
			res.status(404).send("Page with ID: " + id + " not found.");
		}
	});
}

mc.connect("mongodb://localhost:27017/", function(err, client) {
	if(err) throw err;
	console.log("Connected to database.");

  //Specifying the port for the server to run on
  app.listen(3000);
  console.log('server running on port 3000');

	  db = client.db('A1');

		db.collection("PersonalPages").find().toArray(function(err,results){
			for (i in results) {
				gcIndex.addDoc(results[i]);
			}
		});

		//Starting the crawl
		//gcCrawler.queue('https://www.canada.ca/en.html');

		//countGCWords();

		//generatePersonalPageRank();
});

//Calculates the pagerank for all of the GC pages
function generatePersonalPageRank(){

	let adjMatrix = [];

	//Creating a 1000x1000 array of all zeros
	for (let i = 0; i < 1000; i++){
		let row = [];

		for (let j = 0; j < 1000; j++){
			row.push(0);
		}

		adjMatrix.push(row);
	}

	//Getting all of the pages from the db in sorted order (and excluding the text field for efficiency)
	db.collection("PersonalPages").find().project({text:0, wordCounts:0}).toArray(function(err,results){
		let urlList = [];

		for (p in results){
			urlList.push(results[p]["url"]);
		}

		for (p in results){
			//Updating the array one row at a time by replacing each zero with a one / number of incoming links for each incoming link
			for (link in results[p].incomingLinks){
				for (url in urlList){
					if (results[p]["incomingLinks"][link] == urlList[url]){
						adjMatrix[p][url] = 1 / results[p].incomingLinks.length;
					}
				}
			}
		}

		//Using the now populated array to create the matrix
		let m = new Matrix(adjMatrix);

		//Creating an array for the first instance of the vector, with the first entry being 1 and the others being 0
		let x0Arr = [1];

		for (i = 0; i < 999; i++){
			x0Arr.push(0);
		}

		//Creating the matrices (the value of x1 does not matter here)
		let x0 = new Matrix([x0Arr]);
		let x1 = new Matrix([x0Arr]);

		//Multipling the matrix by 1-alpha, then adding alpha / N
		m = m.mul(1-alpha);
		m = m.add(alpha / results.length);

		let difference = 99;
		let count = 0;

		//Looping until the difference between each vector is sufficiently small
		while (difference >= euclDist){
			//console.log("count: " + count);
			count++;

			//Multipling the vector by the original matrix
			x0 = x0.mmul(m);

			//Checking the difference between the current iteration and the previous
			let curr = x0.getRow(0);
			let prev = x1.getRow(0);
			difference = 0;

			for (i in curr){
				if (Math.abs(curr[i] - prev[i]) > difference){
					difference = Math.abs(curr[i] - prev[i]);
					if (difference > euclDist){
						break;
					}
				}
			}

			//Setting the "previous" = to the "current" one to set up for the next iteration
			x1 = x0;
		}

		let row = x0.getRow(0)

		//Updating the db with the pagerank values
		for (i in row){
			db.collection("PersonalPages").updateOne({
				id : parseInt(i)+1},
				{$set : {pagerank : row[i]}},
				function(err,result){
					if (err) throw err;
			});
		}
	});
}

//Counts the frequency of each word on a page
function countGCWords(){
	//Getting all the entries from the db
	db.collection("PersonalPages").find().toArray(function(err,results){
		for (r in results){
			let result = results[r];

			let arr;
			//Splitting by whitespace
			if (result["text"]){
				arr = result["text"].split(/\s+/);
			}else {
				arr = [""];
			}
			let countObj = {};

			//Either incrementing or creating a new attribute
			for (i in arr) {
				if (countObj[arr[i]]){
					countObj[arr[i]]++;
				}else if (arr[i] != '' && !arr[i].startsWith("$")){
					countObj[arr[i]] = 1;
				}
			}

			//Updating the db
			db.collection("PersonalPages").updateOne({id : parseInt(result["id"])}, {$set : {wordCounts : countObj}}, function(err,result){
				if(err) throw err;
			});
		}
	});
}
