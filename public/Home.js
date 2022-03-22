//Function that takes the users input and then sends a request to the server.
function search(){
  let qStr = document.getElementById("qBox").value;
  let boost = document.getElementById("boostBox").checked;
  let numResults = document.getElementById("resultsBox").value;
  let network = document.getElementById("networkChoice").value;

  if (!numResults || numResults > 50 || numResults < 1){
    numResults = 10;
  }

  let reqStr = "/";
  reqStr += network;
  reqStr += "?boost=" + boost;
  reqStr += "&limit=" + numResults;
  if (qStr){
    reqStr += "&q=" + qStr;
  }

  console.log(reqStr);

  let request = new XMLHttpRequest();
  request.open("GET", reqStr);
  request.send();

  request.onreadystatechange = function(){
    //Case where good response is recieved
    if(this.readyState==4 && this.status == 200){
      //Displaying the pug/html page
      document.body.innerHTML = this.responseText;
    }else if (this.readyState == 4){
      alert(this.responseText);
    }
  }
}
